// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardLegacySliceDomainTest
/// @notice 3b-ii-A2-ii (c) — an entry's pre-arming LEGACY SLICE, priced whole-
///         window, consumes the epochs that list its days BEFORE the schedule
///         funds it: prepared and consumed as a domain, settled exactly once.
contract RewardLegacySliceDomainTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    uint256 internal constant EPOCH = 0.1e18;

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
        alice = makeAddr("legacy-alice");
    }

    function _epoch() internal view returns (RewardEpochFacet) { return RewardEpochFacet(address(diamond)); }
    function _domain() internal view returns (RewardStagingDomainFacet) { return RewardStagingDomainFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _view() internal view returns (RewardEpochViewFacet) { return RewardEpochViewFacet(address(diamond)); }
    function _cfg() internal view returns (ConfigFacet) { return ConfigFacet(address(diamond)); }

    function _day(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
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

    /// @dev An attested, fully fresh epoch listing day `d` (a pre-arming day).
    function _epochOn(uint256 d, uint256 amount, uint256 remitId) internal returns (bytes32 h) {
        bytes32 id = keccak256(abi.encode("legacy-epoch", d, remitId));
        _ingress().onRewardBudgetReceived(address(vpfi), amount, _one(d), CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        _epoch().materializeTransportBatchPage(h, _one(d));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, remitId, amount, 0);
    }

    function _liveFresh(uint256 amount) internal {
        _ingress().onRewardBudgetReceived(
            address(vpfi), amount, _one(1), CHAIN_BASE, 1000 + amount / 1e17, REMITTER, 0, amount, keccak256(abi.encode("live", amount)), true
        );
        _mut().setArmedFreshLedgerRaw(amount, 0);
    }

    /// @dev Days 1..2 accrue; the arming is day 5, so the entry [1, 3) is wholly
    ///      pre-arming — one legacy slice, priced whole-window.
    function _legacyScene() internal returns (uint256 id) {
        _day(1); _day(2);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _loanSideOpen(2);
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    /// @dev The slice's whole-window fresh, as the armed-need view prices it.
    function _legacyTotal() internal view returns (uint256 total) {
        (, , , total, , , , ) = _view().getUserArmedFreshNeedWithLegs(alice);
    }

    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) {
        (f, r) = _epoch().getTransportBatchLegs(h);
    }

    function _dom(uint256 id) internal view returns (uint8 phase, uint64 preparedThrough, uint32 live, uint256 epochFresh) {
        (, phase, , , preparedThrough, , live, epochFresh) = _domain().getLegacySliceDomain(id);
    }

    /// @dev No epoch lists any of the slice's days: it pays as before, at once,
    ///      and no domain is opened.
    function test_ASliceNoEpochLists_PaysAsBefore() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        assertGt(total, 0, "fixture: a legacy slice");
        _liveFresh(total + 1e18); // the slice prices by the SCHEDULE (~1e22 a day): the live sources must bear the whole
        assertEq(_claim(), total, "paid whole from the live sources");
        (uint8 phase, , , ) = _dom(id);
        assertEq(phase, 0, "no domain");
    }

    /// @dev An epoch lists a pre-arming day of the slice: the first claim
    ///      PREPARES (the slice's domain opens, the listed day's record is
    ///      staged) and defers; the next claim consumes and settles — the
    ///      claimant receives the whole slice, the epoch's fresh leg records
    ///      what it paid, the live sources paid only the rest, the domain is
    ///      gone and the slice is settled exactly once.
    function test_AListedPreArmingDay_IsConsumedBeforeTheScheduleFunds() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        bytes32 h = _epochOn(1, EPOCH, 7);
        _liveFresh(total + 1e18); // the slice prices by the SCHEDULE (~1e22 a day): the live sources must bear the whole
        uint256 before = vpfi.balanceOf(alice);
        uint256 ledgerBefore = _mut().getArmedFreshPaidRaw();
        assertEq(_claim(), 0, "the first claim prepares the slice and defers");
        assertEq(vpfi.balanceOf(alice), before, "and nothing moved");
        (uint8 phase, uint64 prepared, uint32 live, uint256 ef) = _dom(id);
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging), "preparing");
        assertEq(prepared, 2, "the window prepared");
        assertEq(live, 1, "the listed day's record");
        assertEq(ef, 0);
        assertEq(_claim(), total, "the second claim consumes and pays the whole slice");
        assertEq(vpfi.balanceOf(alice) - before, total, "delivered whole: the epoch's part and the live part in one payout");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, EPOCH, "the epoch paid its fresh leg");
        assertEq(_mut().getArmedFreshPaidRaw() - ledgerBefore, total - EPOCH, "the live ledger charged for the rest only");
        (phase, , live, ) = _dom(id);
        assertEq(phase, 0, "the domain is gone"); assertEq(live, 0);
        vm.prank(alice);
        (bool ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        assertFalse(ok, "settled once: nothing left to claim");
    }

    /// @dev #1566 PR 1 review (P2-2) — two slices of ONE claimant and side over the same listed
    ///      day each keep their own day record: the second opens its own rather than preparing,
    ///      and later consuming, the first slice's coverage. (Under the shared (user, side, day)
    ///      key the second slice opened none and consumed the first's.)
    function test_TwoSlicesOfOneClaimant_EachKeepTheirOwnRecord() public {
        uint256 a = _legacyScene();
        _mut().setFeeEntitlementRaw(
            LOAN + 1,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 2,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
        uint256 b = _mut().pushRewardEntry(alice, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(b, 3);
        _mut().userClaimFundingNeedRaw(alice);
        _epochOn(1, EPOCH, 7);
        _liveFresh(_legacyTotal() + 1e18);
        assertEq(_claim(), 0, "the first claim prepares the slices and defers");
        (, , uint32 liveA, ) = _dom(a);
        (, , uint32 liveB, ) = _dom(b);
        assertEq(liveA, 1, "the first slice's own record");
        assertEq(liveB, 1, "the second slice's own record, never the first's");
    }

    /// @dev #1566 PR 1 review (P2-3) — the slice of a loan still OPEN opens no domain: a claim does
    ///      not stage its epochs, so no earmark sits in the staged total for the life of the loan
    ///      (blocking custody activation). Before the fix the claim opened and prepared it.
    function test_AnOpenLoansSlice_OpensNoDomain() public {
        uint256 closed = _legacyScene(); // a CLOSED entry over the listed day: its slice prepares, so the claim succeeds
        _mut().setFeeEntitlementRaw(
            LOAN + 1,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 2,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
        uint256 open = _mut().pushRewardEntry(alice, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 1); // never closed
        _mut().userClaimFundingNeedRaw(alice);
        _epochOn(1, EPOCH, 7);
        _liveFresh(_legacyTotal() + 1e18);
        assertEq(_claim(), 0, "the claim succeeds: the closed slice prepares and defers");
        (uint8 phaseClosed, , , ) = _dom(closed);
        assertEq(phaseClosed, uint8(LibVaipakam.DomainPhase.Staging), "fixture-live: the claim persisted its preparation");
        (uint8 phaseOpen, , , ) = _dom(open);
        assertEq(phaseOpen, 0, "no domain for the open loan's slice");
    }

    /// @dev #1566 PR 1 review (P2-4) — a slice record that passes more pending epochs than it
    ///      tracks stops staging and CONSUMES what it already holds: the claim still settles the
    ///      slice (the epoch it staged pays its fresh leg, the live sources the rest). Before, the
    ///      next preparation reverted `StagingPendingOverflow` inside every claim of the owner, for
    ///      good — a legacy record is never unwound.
    function test_AnOverflowingSliceRecord_ConsumesWhatItHolds_TheClaimStillSettles() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        bytes32 h = _epochOn(1, EPOCH, 7); // typed: the record stages it on its first page
        for (uint256 i; i < 140; ++i) { // untyped: pending, more than one tracked page of them
            vm.warp(vm.getBlockTimestamp() + 10);
            bytes32 pid = keccak256(abi.encode("legacy-pending", i));
            _ingress().onRewardBudgetReceived(address(vpfi), 1e12, _one(1), CHAIN_BASE, 500 + i, REMITTER, 0, 0, pid, false);
            _epoch().materializeTransportBatchPage(keccak256(abi.encode(uint256(CHAIN_BASE), pid)), _one(1));
        }
        _liveFresh(total + 1e18);
        bytes32 key = LibRewardCustody.legacyRecordKey(LibRewardCustody.legacyDomainKey(id), 1);
        uint256 before = vpfi.balanceOf(alice);
        bool overflowSeen;
        uint256 paid;
        for (uint256 k; k < 8 && paid == 0; ++k) {
            paid = _claim(); // never reverts: each claim moves the slice one step
            if (_view().getStagingRecord(key).pendingOverflow) overflowSeen = true;
        }
        assertTrue(overflowSeen, "fixture-live: the slice's record passed more pending epochs than it tracks");
        assertEq(paid, total, "the claim still settles the whole slice");
        assertEq(vpfi.balanceOf(alice) - before, total, "delivered whole");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, EPOCH, "the epoch the record held paid its fresh leg");
        (uint8 phase, , , ) = _dom(id);
        assertEq(phase, 0, "the domain is gone");
    }

    /// @dev Anyone may drive the slice home ahead of the settlement; the claim
    ///      then pays at once.
    function test_StepLegacySlice_DrivesTheSliceHome() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        _epochOn(1, EPOCH, 7);
        _liveFresh(total + 1e18); // the slice prices by the SCHEDULE (~1e22 a day): the live sources must bear the whole
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.LegacySliceNotPending.selector, id));
        _domain().stepLegacySlice(id); // no domain yet: the slice has not met a settlement
        assertEq(_claim(), 0, "the claim opens the domain and prepares");
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        assertTrue(_domain().stepLegacySlice(id), "consumed by a stranger");
        (uint8 phase, , , uint256 ef) = _dom(id);
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Resolving)); assertEq(ef, EPOCH);
        assertEq(_claim(), total, "and the claim pays at once");
    }

    /// @dev The forfeit sweep's whole-window branch consumes the slice's epochs
    ///      too: the treasury's epoch part is absorbed in place, the live part
    ///      from the live sources, the bucket credited the whole.
    function test_TheForfeitSweep_ConsumesTheSlicesEpochs() public {
        uint256 id = _legacyScene();
        uint256 total = _legacyTotal();
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        bytes32 h = _epochOn(1, EPOCH, 7);
        _liveFresh(total + 1e18); // the slice prices by the SCHEDULE (~1e22 a day): the live sources must bear the whole
        uint256 bucketBefore = _cfg().getRecycleBucket();
        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), 0, "the first sweep prepares");
        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), total, "the second consumes and settles");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, total, "the whole slice recycled");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, EPOCH, "the epoch's leg recorded");
        (uint8 phase, , , ) = _dom(id);
        assertEq(phase, 0, "the domain is gone");
    }
}
