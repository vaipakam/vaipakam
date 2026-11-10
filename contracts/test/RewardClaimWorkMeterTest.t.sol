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
}
