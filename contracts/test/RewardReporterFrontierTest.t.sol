// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardReporterFrontierTest
/// @notice #2277 — a chain's day-close report reads that day's per-side totals
///         from the interest fold, which advances a bounded number of days per
///         call. A day the fold has not reached is NOT reported: the close is
///         refused by name, anyone catches the fold up for elapsed days in
///         bounded steps, and then the close reports the FOLDED total — never
///         a zero shipped once and made irreversible by the stamp.
contract RewardReporterFrontierTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint256 internal constant PER_DAY = 1e18;
    uint256 internal constant REACH = 730; // MAX_FRONTIER_ADVANCE_DAYS
    uint256 internal launch;

    event InterestFrontiersAdvanced(uint256 through, uint256 lenderFrontier, uint256 borrowerFrontier);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        launch = block.timestamp;
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(launch);
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        _agg().setExpectedSourceChainIds(chainIds);
        // One lender obligation of PER_DAY open from day 1, never closed: every
        // folded day from 1 carries exactly PER_DAY on the lender side.
        _mut().setInterestFoldDeltaRaw(1, int256(PER_DAY), 0);
    }

    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _agg() internal view returns (RewardAggregatorFacet) { return RewardAggregatorFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }

    /// @dev Move the clock so that `today == days_` (the day `days_ - 1` has elapsed).
    function _today(uint256 days_) internal {
        vm.warp(launch + days_ * 1 days + 1);
    }

    /// @dev THE defect: a gap wider than one fold reach. Before #2277 this call
    ///      stamped the day and shipped zero totals once, irreversibly.
    function test_ACloseDayAcrossAWideGap_RefusesShort_ThenReportsTheFoldedTotal() public {
        _today(900);
        uint256 d = 899;
        vm.expectRevert(abi.encodeWithSelector(RewardReporterFacet.ChainReportFrontierShort.selector, d, REACH, REACH));
        _rep().closeDay(d);
        assertEq(_rep().getChainReportSentAt(d), 0, "not stamped");
        (uint256 lf, uint256 bf) = _rep().getInterestFrontiers();
        assertEq(lf, 0, "the refused close left no partial fold behind");
        assertEq(bf, 0);

        // Anyone catches the fold up in bounded steps.
        vm.prank(makeAddr("anyone"));
        (lf, bf) = _rep().advanceInterestFrontiers(d);
        assertEq(lf, REACH, "one reach per call");
        assertEq(bf, REACH);
        vm.expectEmit(true, true, true, true);
        emit InterestFrontiersAdvanced(d, d, d);
        (lf, bf) = _rep().advanceInterestFrontiers(d);
        assertEq(lf, d, "caught up");
        assertEq(bf, d);

        _rep().closeDay(d);
        assertGt(_rep().getChainReportSentAt(d), 0, "stamped now");
        (uint256 l, uint256 b) = _agg().getChainReport(d, CHAIN_BASE);
        assertEq(l, PER_DAY, "the REPORTED lender total is the folded figure, not zero");
        assertEq(b, 0);
        (uint256 ll, uint256 bb) = _rep().getLocalChainInterestNumeraire18(d);
        assertEq(ll, PER_DAY, "and so is the local total");
        assertEq(bb, 0);
    }

    /// @dev The catch-up is bounded to elapsed days, exactly as the close is: a
    ///      frontier run ahead of the clock would drop later registrations.
    function test_TheCatchUp_IsBoundedToElapsedDays() public {
        _today(900);
        vm.expectRevert(RewardDayNotElapsed.selector);
        _rep().advanceInterestFrontiers(900); // today
        vm.expectRevert(RewardDayNotElapsed.selector);
        _rep().advanceInterestFrontiers(5_000); // ahead
        (uint256 lf, uint256 bf) = _rep().advanceInterestFrontiers(10);
        assertEq(lf, 10);
        assertEq(bf, 10);
        // A call that cannot move is a no-op, not a revert.
        (lf, bf) = _rep().advanceInterestFrontiers(10);
        assertEq(lf, 10);
        assertEq(bf, 10);
    }

    /// @dev Within one reach the close still folds and reports in ONE call.
    function test_WithinOneReach_CloseDayReportsInOneCall() public {
        _today(100);
        _rep().closeDay(99);
        (uint256 l, ) = _agg().getChainReport(99, CHAIN_BASE);
        assertEq(l, PER_DAY, "reported in one call");
        (uint256 lf, uint256 bf) = _rep().getInterestFrontiers();
        assertEq(lf, 99);
        assertEq(bf, 99);
    }

    /// @dev A mirror ships the folded figure over the wire, and nothing before.
    function test_AMirror_ShipsTheFoldedFigure_NeverAShortOne() public {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _today(900);
        uint256 d = 899;
        vm.expectRevert(abi.encodeWithSelector(RewardReporterFacet.ChainReportFrontierShort.selector, d, REACH, REACH));
        _rep().closeDay(d);
        assertEq(messenger.lastSendDay(), 0, "nothing shipped");
        _rep().advanceInterestFrontiers(d);
        _rep().advanceInterestFrontiers(d);
        _rep().closeDay(d);
        assertEq(messenger.lastSendDay(), d, "shipped once the fold reached the day");
        assertEq(messenger.lastSendLenderNumeraire18(), PER_DAY, "with the folded lender total");
        assertEq(messenger.lastSendBorrowerNumeraire18(), 0);
    }
}
