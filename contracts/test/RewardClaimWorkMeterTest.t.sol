// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibClaimWork} from "../src/libraries/LibClaimWork.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibD8Delivery} from "./helpers/LibD8Delivery.sol";

/// @notice #1787 — a reward claim does BOUNDED work per call. Its walk, a
///         domain's preparation and every domain page charge each step to one
///         work meter ({LibClaimWork}) and stop, progress kept, when the next
///         step does not fit; so a backlog of any size settles over successive
///         calls, each inside one transaction, and pays every day exactly once.
///         Before #1787 the walk bounded days only: 40 entries over 30 days
///         cost 28.4M gas in one claim, 200 entries on one day 27.3M, and a
///         10-entry 40-day backlog 20.4M to prepare, all above the 16.77M
///         per-transaction cap, with every later claim facing the same work.
contract RewardClaimWorkMeterTest is SetupTest {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint256 internal constant NEED = 0.4e18;
    /// @dev Every call in these cells must stay well inside the 16,777,216
    ///      per-transaction gas cap (EIP-7825).
    uint256 internal constant CALL_CEILING = 12_000_000;

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
        if (1_000_000 ether > have) vpfi.mint(address(this), 1_000_000 ether - have);
        vpfi.transfer(address(diamond), 1_000_000 ether);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("meter-alice");
    }

    // ───────────────────────── fixtures ─────────────────────────

    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _domain() internal view returns (RewardStagingDomainFacet) { return RewardStagingDomainFacet(address(diamond)); }

    /// @dev `n` lender entries, each over `days_` armed days from day 1, the
    ///      wallet's day ceiling `NEED` per entry, with the live fresh to fund it.
    function _scene(uint256 n, uint32 days_) internal returns (uint256[] memory ids) {
        return _scene(n, days_, NEED * n);
    }

    /// @dev As above with the wallet's per-day ceiling `cap`, and funding for
    ///      every entry's whole share whatever the ceiling.
    function _scene(uint256 n, uint32 days_, uint256 cap) internal returns (uint256[] memory ids) {
        for (uint256 d = 1; d <= days_; ++d) {
            _mut().setDayPoolStampRaw(d, uint128(2e18 * n), 0);
            _mut().setKnownGlobalDailyInterest(d, 1e18 * n, 0, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
            _mut().setDayCapModeRaw(d, 1);
            _mut().setDayUserSideCapRaw(d, cap);
        }
        _mut().setGovernorCommitArmedFromDayRaw(1);
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint64 loan = uint64(100 + i);
            _mut().setFeeEntitlementRaw(
                loan,
                LibVaipakam.FeeEntitlement({
                    borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                    lenderMode: LibVaipakam.FeeEntitlementMode.None,
                    openDays: days_,
                    rewardHaircutBpsAtOpen: 0,
                    borrowerTariffPaid: 0,
                    lenderTariffPaid: 0,
                    cStarOpen: 0,
                    loanSideRewardCapOpen: type(uint128).max
                })
            );
            ids[i] = _mut().pushRewardEntry(alice, loan, LibVaipakam.RewardSide.Lender, 1e18, 1);
            _mut().closeRewardEntryRaw(ids[i], days_ + 1);
        }
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        uint256 amt = 2e18 * n * days_;
        LibD8Delivery.liveFresh(
            address(diamond), address(vpfi), amt, 1, CHAIN_BASE, 1000, address(0xBA5E), keccak256(abi.encode("live", amt))
        );
        _mut().setArmedFreshLedgerRaw(amt, 0);
    }

    /// @dev One claim; asserts it fit, returns whether it succeeded.
    function _claimOnce() internal returns (bool ok) {
        vm.prank(alice);
        (ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        assertLt(vm.lastCallGas().gasTotalUsed, CALL_CEILING, "a claim stays inside one transaction");
    }

    /// @dev Claim until a claim has nothing to do; returns the calls taken.
    function _claimUntilDone(uint256 maxCalls) internal returns (uint256 calls) {
        while (_claimOnce()) {
            if (++calls > maxCalls) fail();
        }
    }

    function _dk() internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender));
    }

    // ───────────────────────── cells ─────────────────────────

    /// @dev The meter's own invariants: a domain day of the largest snapshot
    ///      fits a fresh budget in the preparation and in every page, and a
    ///      fresh walk always takes at least one entry.
    function test_EveryFirstStep_FitsAFreshBudget() public pure {
        assertLe(
            LibClaimWork.PREP_DAY + LibClaimWork.DOMAIN_MAX_ENTRIES * LibClaimWork.PREP_ENTRY_FIRST,
            LibClaimWork.BUDGET
        );
        assertLe(
            LibClaimWork.PAGE_DAY + LibClaimWork.DOMAIN_MAX_ENTRIES * LibClaimWork.PAGE_ENTRY,
            LibClaimWork.BUDGET
        );
        assertGe(LibClaimWork.freshWalkCapacity(), 1);
    }

    /// @dev A day with more entries than one call carries is paid over
    ///      successive claims, its leading entries first, every entry once.
    function test_ALargeDay_IsPaidOverSuccessiveClaims_EachInsideOneTransaction() public {
        uint256 reach = LibClaimWork.freshWalkCapacity();
        uint256 n = reach * 3 + 5;
        uint256[] memory ids = _scene(n, 1, type(uint256).max); // no wallet ceiling: each entry's own share
        assertTrue(_claimOnce());
        uint256 first = vpfi.balanceOf(alice);
        assertGt(first, 0);
        assertEq(first % reach, 0, "one share per entry reached");
        uint256 share = first / reach;
        assertEq(_processedCount(ids), reach, "the first claim reaches what one call carries");
        uint256 calls = 1 + _claimUntilDone(8);
        assertEq(calls, 4, "the rest over three more claims");
        assertEq(_processedCount(ids), n, "every entry settled");
        assertEq(vpfi.balanceOf(alice), n * share, "every entry paid its share, once");
    }

    /// @dev Many entries over a month: the walk stops when the meter is spent
    ///      and the next claim continues; the total is unchanged.
    function test_AMonthOfManyEntries_SettlesInBoundedClaims() public {
        uint256 n = 40;
        uint32 days_ = 30;
        _scene(n, days_);
        uint256 calls = _claimUntilDone(40);
        assertGt(calls, 1, "more than one call: one could not carry it");
        assertEq(vpfi.balanceOf(alice), n * days_ * NEED, "every entry-day paid, once");
    }

    /// @dev A backlog longer than one chunk opens a DOMAIN: its snapshot takes
    ///      at most DOMAIN_MAX_ENTRIES entries, its preparation and every page
    ///      stay inside one transaction, and the entries outside the snapshot
    ///      are paid after it clears.
    function test_ALongBacklog_DomainSnapshotIsBounded_EveryStepFits() public {
        uint256 n = LibClaimWork.DOMAIN_MAX_ENTRIES + 8;
        uint32 days_ = 40;
        uint256[] memory ids = _scene(n, days_);
        // Preparation: claims pay nothing while the domain prepares.
        uint256 calls = _claimUntilDone(40);
        assertGt(calls, 0);
        (, , , , , , , , , , , , uint256 entryCount) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
        assertEq(entryCount, LibClaimWork.DOMAIN_MAX_ENTRIES, "the snapshot is bounded");
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid while the domain prepares");
        // Reserve and resolve; then the entries outside the snapshot take the
        // next domain. Every claim and every page inside one transaction.
        _settleDomain();
        for (uint256 round; round < 4; ++round) {
            _claimUntilDone(40);
            (, uint8 phase, , , , , , , , , , , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
            if (phase == uint8(LibVaipakam.DomainPhase.None)) break;
            _settleDomain();
        }
        assertEq(_processedCount(ids), n, "every entry settled, the snapshot's and the rest");
        // The wallet's day ceiling (NEED x n) binds every day: the snapshot
        // takes it all, so the total is the ceiling over the backlog, once.
        assertEq(vpfi.balanceOf(alice), NEED * n * days_, "every day paid, once");
    }

    function _settleDomain() internal {
        uint256 pages;
        while (true) {
            bool done = _domain().reserveDomainPage(_dk());
            assertLt(vm.lastCallGas().gasTotalUsed, CALL_CEILING, "a reserve page fits");
            if (done) break;
            if (++pages > 64) fail();
        }
        pages = 0;
        while (true) {
            bool done = _domain().resolveDomainPage(_dk());
            assertLt(vm.lastCallGas().gasTotalUsed, CALL_CEILING, "a resolve page fits");
            if (done) break;
            if (++pages > 128) fail();
        }
    }

    function _processedCount(uint256[] memory ids) internal view returns (uint256 c) {
        LibVaipakam.RewardEntry[] memory es =
            InteractionRewardsLensFacet(address(diamond)).getRewardEntriesRange(ids[0], ids.length);
        for (uint256 i; i < es.length; ++i) if (es[i].processed) ++c;
    }

    /// @dev The expiry clock's per-entry read follows the meter: an entry the
    ///      next claim cannot reach is not executable now; one it reaches is.
    function test_TheEntryRead_AgreesWithTheMetersReach() public {
        uint256 reach = LibClaimWork.freshWalkCapacity();
        uint256[] memory ids = _scene(reach + 3, 1);
        (, , , , , bool capFirst, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(ids[0]);
        (, , , , , bool capLast, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(ids[reach + 2]);
        assertFalse(capFirst, "within reach: the next claim pays it");
        assertTrue(capLast, "past reach: not this claim's");
    }

    /// @dev The static preview reads the next claim's day as the meter does:
    ///      a day larger than one call carries counts only its leading
    ///      entries, so the preview never exceeds what the claim pays.
    function test_ThePreview_CountsOnlyWhatTheMeterCarries() public {
        uint256 reach = LibClaimWork.freshWalkCapacity();
        _scene(reach + 1, 1, type(uint256).max); // no wallet ceiling: each entry's own share
        (uint256 previewed, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(alice);
        assertTrue(_claimOnce());
        uint256 paid = vpfi.balanceOf(alice);
        assertGt(previewed, 0);
        assertLe(previewed, paid, "a lower bound on the claim");
        assertEq(paid % reach, 0, "one share per entry reached");
        assertEq(previewed, paid, "the meter's reach, not the whole day");
    }

    /// @dev While a claim domain stands, its side is the domain's: the claim
    ///      walks none of the side's days, so an entry outside the snapshot is
    ///      not the next claim's and its expiry clock waits, in every phase,
    ///      including after a resolution page has cleared the days it owes.
    function test_AnEntryOutsideTheDomainSnapshot_ItsClockWaits() public {
        uint256 n = LibClaimWork.DOMAIN_MAX_ENTRIES + 8;
        uint256[] memory ids = _scene(n, 40);
        _claimUntilDone(40);
        (, uint8 phase, , , , , , , , , , , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
        assertTrue(phase != uint8(LibVaipakam.DomainPhase.None), "a domain stands");
        _assertWaits(ids[n - 1]);
        uint256 pages;
        while (!_domain().reserveDomainPage(_dk())) {
            _assertWaits(ids[n - 1]);
            if (++pages > 64) fail();
        }
        pages = 0;
        while (true) {
            bool done = _domain().resolveDomainPage(_dk());
            (, phase, , , , , , , , , , , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
            if (phase != uint8(LibVaipakam.DomainPhase.None)) _assertWaits(ids[n - 1]);
            if (done) break;
            if (++pages > 128) fail();
        }
    }

    function _assertWaits(uint256 id) internal view {
        (, , , , , bool capHit, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(id);
        assertTrue(capHit, "outside the snapshot while the domain stands: not the next claim's");
    }

    // ───────────────────────── the claim window ─────────────────────────

    function _window() internal view returns (uint256 from, uint256 to, uint256 total) {
        (from, to, total, ) = InteractionRewardsLensFacet(address(diamond)).getRewardClaimWindow(alice);
    }

    function _windowChangedAt() internal view returns (uint64 changedAt) {
        (, , , changedAt) = InteractionRewardsLensFacet(address(diamond)).getRewardClaimWindow(alice);
    }

    /// @dev A wallet with no more entries than the window reads them all, and
    ///      its window never moves.
    function test_ASmallWallet_TheWindowIsTheWholeIndex() public {
        _scene(40, 1);
        (uint256 from, uint256 to, uint256 total) = _window();
        assertEq(from, 0);
        assertEq(to, 40);
        assertEq(total, 40);
    }

    /// @dev A wallet with more entries than the window: each claim reads one
    ///      window of its index, so what one claim reads is bounded; the window
    ///      moves on after each claim and comes back to the start, so every
    ///      entry is reached and paid once.
    function test_AWalletOverTheWindow_IsServedWindowByWindow_EveryEntryOnce() public {
        uint256 w = LibInteractionRewards.CLAIM_WINDOW_ENTRIES;
        uint256 n = 2 * w + 10;
        uint256[] memory ids = _scene(n, 1, type(uint256).max);
        (uint256 from, uint256 to, uint256 total) = _window();
        assertEq(from, 0);
        assertEq(to, w, "the first claim reads one window");
        assertEq(total, n);

        assertTrue(_claimOnce());
        uint256 reach = LibClaimWork.freshWalkCapacity();
        assertEq(_processedCount(ids), reach, "the meter's reach, inside the window");
        uint256 share = vpfi.balanceOf(alice) / reach;
        // The settled entries left the index, and the window moved on.
        (from, to, total) = _window();
        assertEq(total, n - reach, "the window's settled entries retired");
        assertEq(from, w, "the next claim reads the next window");
        assertEq(to, total < 2 * w ? total : 2 * w);

        uint256 calls = 1 + _claimUntilDone(32);
        assertLe(calls, 16);
        assertEq(_processedCount(ids), n, "every entry reached and settled");
        assertEq(vpfi.balanceOf(alice), n * share, "every entry paid its share, once");
        (from, to, total) = _window();
        assertEq(total, 0, "the index is empty");
    }

    /// @dev An entry outside the window is not the next claim's: its expiry
    ///      clock waits (`capHit`) until a claim's window reaches it.
    function test_AnEntryOutsideTheWindow_ItsClockWaits() public {
        uint256 w = LibInteractionRewards.CLAIM_WINDOW_ENTRIES;
        uint256[] memory ids = _scene(w + 20, 1, type(uint256).max);
        (, , , , , bool capIn, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(ids[0]);
        (, , , , , bool capOut, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(ids[w + 5]);
        assertFalse(capIn, "inside the window and the meter's reach");
        assertTrue(capOut, "outside the window: not the next claim's");
    }
    /// @dev A window whose entries have nothing claimable yet does not hold the
    ///      rest of the index: the claim that read it still moves the window
    ///      (a zero-pay claim, not a revert), and the next claim reads the
    ///      window behind it and pays.
    function test_AWindowWithNothingClaimable_DoesNotHoldTheRest() public {
        uint256 w = LibInteractionRewards.CLAIM_WINDOW_ENTRIES;
        // The first window: open positions whose first reward day is still to
        // come, so nothing in it is claimable now.
        for (uint256 i; i < w; ++i) {
            _mut().pushRewardEntry(alice, uint64(10_000 + i), LibVaipakam.RewardSide.Lender, 1e18, 10_000);
        }
        uint256[] memory ids = _scene(20, 1, type(uint256).max);
        (uint256 from, uint256 to, uint256 total) = _window();
        assertEq(from, 0);
        assertEq(to, w);
        assertEq(total, w + 20);

        assertEq(_windowChangedAt(), 0, "the window has not changed yet");
        vm.warp(block.timestamp + 1 hours);
        assertTrue(_claimOnce(), "a claim whose window paid nothing still moves the window");
        assertEq(vpfi.balanceOf(alice), 0, "nothing in the first window was claimable");
        assertEq(_windowChangedAt(), block.timestamp, "the move is recorded for the expiry clocks");
        (from, to, total) = _window();
        assertEq(from, w, "the next claim reads the window behind it");
        assertEq(to, w + 20);

        assertTrue(_claimOnce());
        assertEq(_processedCount(ids), 20, "the entries behind the first window are reached");
        assertGt(vpfi.balanceOf(alice), 0, "and paid");
        (from, , ) = _window();
        assertEq(from, 0, "the window comes back to the start");
    }

    /// @dev Codex #3487 r3 — retiring the window's last entry can reset the
    ///      stored start to zero (the index comes to fit one window). That is
    ///      the window moving, so the claim counts it as progress and stands:
    ///      read back after the retirement, the reset looked like no move, the
    ///      claim reverted, and the retirement and reset rolled back with it.
    function test_ARetirementThatResetsTheWindow_IsTheClaimsProgress() public {
        uint256 w = LibInteractionRewards.CLAIM_WINDOW_ENTRIES;
        for (uint256 i; i < w; ++i) {
            _mut().pushRewardEntry(alice, uint64(10_000 + i), LibVaipakam.RewardSide.Lender, 1e18, 10_000);
        }
        uint256[] memory ids = _scene(1, 1, type(uint256).max);
        assertTrue(_claimOnce(), "the first window paid nothing and moved on");
        (uint256 from, , uint256 total) = _window();
        assertEq(from, w);
        assertEq(total, w + 1);

        // The one entry the window now holds is settled elsewhere (as an
        // expiry sweep would), so the next claim only retires it.
        _mut().setRewardEntryProcessedRaw(ids[0], true);
        vm.warp(block.timestamp + 1 hours);
        assertTrue(_claimOnce(), "the retirement that resets the window is the claim's progress");
        (from, , total) = _window();
        assertEq(from, 0, "the window is back at the start");
        assertEq(total, w, "the settled entry left the index");
        assertEq(_windowChangedAt(), block.timestamp, "the reset is recorded for the expiry clocks");
    }
}
