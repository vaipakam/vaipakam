// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {RateReference} from "../src/oracle/reference/RateReference.sol";
import {RateReferenceReads} from "../src/oracle/reference/RateReferenceReads.sol";
import {IRateReference} from "../src/interfaces/IRateReference.sol";
import {MockRateSource} from "../src/oracle/reference/MockRateSource.sol";
import {AnnualRayRateReader} from "../src/oracle/reference/AnnualRayRateReader.sol";
import {PerSecondUtilisationRateReader} from "../src/oracle/reference/PerSecondUtilisationRateReader.sol";

/// @dev A market shaped like reader shape 1: a reserve record whose fifth
///      word is the annual borrowing rate scaled by 1e27.
contract RayMarketMock {
    uint256 public ray;

    function set(uint256 r) external {
        ray = r;
    }

    function getReserveData(address) external view returns (uint256, uint128, uint128, uint128, uint128, uint128) {
        return (0, 1, 2, 3, uint128(ray), 5);
    }
}

/// @dev A market shaped like reader shape 2.
contract UtilisationMarketMock {
    address public baseToken;
    uint64 public perSecond;

    constructor(address b) {
        baseToken = b;
    }

    function set(uint64 r) external {
        perSecond = r;
    }

    function getUtilization() external pure returns (uint256) {
        return 5e17;
    }

    function getBorrowRate(uint256) external view returns (uint64) {
        return perSecond;
    }
}

/// @title RateReferenceTest — #3337 part 1 and #3713 (the rate reference).
/// @notice The numbering follows `RateReferenceDesign.md` section 13 and
///         `TermAverageAndLinkGuardsDesign.md` section 11.
contract RateReferenceTest is Test {
    RateReference internal rr;
    MockRateSource[5] internal src;
    address internal constant ASSET = address(0xA55E7);
    address internal owner = address(0xA11CE);
    address internal guardian = address(0x6A2D);
    address internal diamond = address(0xD1A);

    uint256 internal constant PCT = 1e16; // 1% a year, 1e18-scaled

    /// @dev The test clock. viaIR may reuse one read of `block.timestamp`
    ///      across `vm.warp` calls inside a function, so time is tracked here.
    uint256 internal now_;

    function _warp(uint256 dt) internal {
        now_ += dt;
        vm.warp(now_);
    }

    function setUp() public {
        vm.chainId(31337);
        now_ = 1_800_000_000;
        vm.warp(now_);
        rr = new RateReference(owner, guardian, diamond, 0);
        for (uint256 i; i < 5; ++i) {
            src[i] = new MockRateSource(address(this));
            src[i].setRate(ASSET, 5 * PCT);
        }
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _cfg(uint256 n) internal view returns (IRateReference.SeriesConfig memory c) {
        c.sources = new IRateReference.Source[](n);
        for (uint256 i; i < n; ++i) {
            c.sources[i] = IRateReference.Source(address(src[i]), address(src[i]), bytes32(0));
        }
        c.interval = 1 hours;
        c.minSpacing = 15 minutes;
        c.stepBpsPerHour = 50;
        c.toleranceBps = 300;
        c.ceilingBps = 10_000;
    }

    function _open(uint256 n) internal returns (uint32 id) {
        vm.prank(owner);
        id = rr.proposeSeries(ASSET, _cfg(n));
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
    }

    function _setAll(uint256 r) internal {
        for (uint256 i; i < 5; ++i) {
            src[i].setRate(ASSET, r);
        }
    }

    function _hourly(uint256 hours_) internal {
        for (uint256 i; i < hours_; ++i) {
            _warp(1 hours);
            rr.update(ASSET);
        }
    }

    /// @dev The read side the reference deployed.
    function _rd() internal view returns (RateReferenceReads) {
        return RateReferenceReads(rr.READS());
    }

    function _ref() internal view returns (uint256) {
        return _rd().status(ASSET).referenceRate;
    }

    // ─── 1. Quorum ───────────────────────────────────────────────────────

    function test_Quorum_MedianOfThreeFourFive() public {
        _open(5);
        // Five readings: 4, 5, 6, 7, 8 -> median 6 (step limit permits 0.5/h).
        for (uint256 i; i < 5; ++i) {
            src[i].setRate(ASSET, (4 + i) * PCT);
        }
        _warp(1 hours);
        rr.update(ASSET);
        assertEq(_ref(), 5 * PCT + 50 * 1e14, "moves toward 6 by the step");
        // Four readings (one failing): 4, 5, 6, 7 -> median 5.5.
        src[4].setFailing(true);
        _hourly(4);
        assertEq(_ref(), 55 * PCT / 10, "median of four is the middle average");
    }

    function test_Quorum_NoAgreementHolds() public {
        _open(3);
        src[0].setRate(ASSET, 1 * PCT);
        src[1].setRate(ASSET, 10 * PCT);
        src[2].setRate(ASSET, 20 * PCT);
        _warp(1 hours);
        rr.update(ASSET);
        IRateReference.Status memory st = _rd().status(ASSET);
        assertTrue(st.holding);
        assertEq(st.referenceRate, 5 * PCT);
    }

    function test_Quorum_TwoReadingsHoldEvenWhenEqual() public {
        _open(3);
        src[2].setFailing(true);
        _setAll(9 * PCT);
        _warp(1 hours);
        rr.update(ASSET);
        assertTrue(_rd().status(ASSET).holding);
        assertEq(_ref(), 5 * PCT);
    }

    function test_Quorum_RevertingReaderIsLeftOut() public {
        _open(4);
        // src[3]'s market points elsewhere: it reads as failed, three remain.
        src[3].setFailing(true);
        _warp(1 hours);
        rr.update(ASSET);
        assertFalse(_rd().status(ASSET).holding);
    }

    function test_Quorum_MuteHoldsWhateverTheOthersSay() public {
        _open(4);
        IRateReference.Source memory s0 = IRateReference.Source(address(src[0]), address(src[0]), bytes32(0));
        vm.prank(guardian);
        rr.mute(ASSET, s0);
        _setAll(6 * PCT);
        _warp(1 hours);
        rr.update(ASSET);
        assertTrue(_rd().status(ASSET).holding, "agreeing readings are held, not re-read, once one is muted");
        assertEq(_ref(), 5 * PCT);
    }

    // ─── 2. Limits ───────────────────────────────────────────────────────

    function test_StepLimit_CountsAtMostOneInterval() public {
        _open(3);
        _setAll(50 * PCT);
        _warp(10 hours);
        rr.update(ASSET);
        assertEq(_ref(), 5 * PCT + 50 * 1e14, "a long gap stores up no large jump");
    }

    function test_StepLimit_ManyUpdatesMoveNoFurtherThanWaiting() public {
        _open(3);
        _setAll(50 * PCT);
        for (uint256 i; i < 4; ++i) {
            _warp(15 minutes);
            rr.update(ASSET);
        }
        assertEq(_ref(), 5 * PCT + 50 * 1e14, "four quarter-hours move one hour's step");
    }

    function test_Ceiling() public {
        IRateReference.SeriesConfig memory c = _cfg(3);
        c.ceilingBps = 400;
        vm.prank(owner);
        rr.proposeSeries(ASSET, c);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        assertEq(_ref(), 4 * PCT, "the starting figure is cut to the ceiling");
    }

    // ─── 3. Index ────────────────────────────────────────────────────────

    function test_Index_SumsInForceReferenceTimesSeconds() public {
        uint32 id = _open(3);
        uint256 expected;
        uint256 r = 5 * PCT;
        _setAll(6 * PCT);
        _warp(1 hours);
        rr.update(ASSET);
        expected += r * 1 hours; // the old figure prices the hour before
        r += 50 * 1e14;
        _warp(30 minutes);
        rr.update(ASSET);
        expected += r * 30 minutes;
        assertEq(rr.seriesOf(id).index, expected);
    }

    function test_Index_HeldTimeCountsHoldsAndGaps() public {
        uint32 id = _open(3);
        // A 5-hour gap: 4 hours beyond the interval count as held.
        _warp(5 hours);
        rr.update(ASSET);
        assertEq(rr.seriesOf(id).held, 4 hours);
        // Now hold (two readings) for two hours.
        src[2].setFailing(true);
        _hourly(1); // becomes holding; the hour before was not held
        _hourly(2);
        assertEq(rr.seriesOf(id).held, 4 hours + 2 hours);
    }

    function test_Index_GapThenOneUpdate_AveragedUnavailableUntilFresh() public {
        _open(3);
        _hourly(30);
        (bool ok,,) = rr.averaged(ASSET, 24 hours);
        assertTrue(ok, "fresh hourly updates are available");
        _warp(24 hours);
        rr.update(ASSET);
        IRateReference.AvgReason why;
        (ok,, why) = rr.averaged(ASSET, 24 hours);
        assertFalse(ok);
        assertEq(uint8(why), uint8(IRateReference.AvgReason.TooMuchHeld));
        // Held time is measured from the checkpoint the read starts at, and
        // the unobserved day is booked at the update that ends it. So the
        // read stays unavailable while its starting checkpoint predates that
        // update (held too much, or no checkpoint inside the gap), and is
        // available once a fresh checkpoint is a window old.
        _hourly(12);
        (ok,,) = rr.averaged(ASSET, 24 hours);
        assertFalse(ok, "half a window of fresh updates is not yet enough");
        _hourly(12);
        (ok,,) = rr.averaged(ASSET, 24 hours);
        assertTrue(ok, "available once a window of fresh updates has passed");
    }

    // ─── 4. A one-transaction push ───────────────────────────────────────

    function test_PushedSourceMovesOnlyTheStep() public {
        uint32 id = _open(3);
        _hourly(2);
        uint256 before = rr.seriesOf(id).index;
        _setAll(80 * PCT);
        _warp(1 hours);
        rr.update(ASSET); // pushed reading priced the past hour at the OLD figure
        _setAll(5 * PCT);
        _warp(1 hours);
        rr.update(ASSET);
        uint256 over2h = rr.seriesOf(id).index - before;
        // hour 1 at 5%, hour 2 at 5.5%: never the pushed 80%.
        assertEq(over2h, 5 * PCT * 1 hours + (5 * PCT + 50 * 1e14) * 1 hours);
        assertEq(_ref(), 5 * PCT, "returns at the same speed");
    }

    // ─── 5. Checkpoints ──────────────────────────────────────────────────

    function test_Checkpoints_OnePerHourFirstCallerLinked() public {
        uint32 id = _open(3);
        uint256 h0 = now_ / 1 hours;
        _warp((h0 + 1) * 1 hours + 1 - now_);
        rr.update(ASSET);
        IRateReference.Checkpoint memory c1 = rr.hourCheckpoint(id, h0 + 1);
        _warp(20 minutes);
        rr.update(ASSET);
        IRateReference.Checkpoint memory c1b = rr.hourCheckpoint(id, h0 + 1);
        assertEq(c1.at, c1b.at, "first caller sets the hour");
        assertEq(c1.prev, h0, "names the hour before");
    }

    function test_Averaged_StaleAndNoSeries() public {
        IRateReference.AvgReason why;
        (,, why) = rr.averaged(ASSET, 24 hours);
        assertEq(uint8(why), uint8(IRateReference.AvgReason.NoSeries));
        _open(3);
        _hourly(30);
        _warp(4 hours);
        (,, why) = rr.averaged(ASSET, 24 hours);
        assertEq(uint8(why), uint8(IRateReference.AvgReason.Stale));
    }

    function test_Averaged_MatchesIndexOverWindow() public {
        _open(3);
        _setAll(9 * PCT);
        _hourly(48);
        (bool ok, uint256 avg,) = rr.averaged(ASSET, 24 hours);
        assertTrue(ok);
        assertEq(avg, 9 * PCT, "reached and held 9% for more than the window");
    }

    // ─── 6. Starting an asset ────────────────────────────────────────────

    function test_Start_FirstReferenceFromProposal_PushAtExecutionGainsNothing() public {
        vm.prank(owner);
        rr.proposeSeries(ASSET, _cfg(3));
        _setAll(50 * PCT);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        assertEq(_ref(), 5 * PCT);
    }

    /// A pending series opens only when it was kept current through the
    /// delay: an untouched proposal-time figure is not stamped fresh.
    function test_Start_OpenRefusedUntilTheSeriesIsWarm() public {
        vm.prank(owner);
        uint32 id = rr.proposeSeries(ASSET, _cfg(3));
        _warp(3 hours + 1); // past the staleness limit with no update
        vm.expectRevert(
            abi.encodeWithSelector(RateReference.SeriesNotWarm.selector, id, uint64(now_ - 3 hours - 1), false)
        );
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));

        // A disagreeing read leaves it holding: still refused.
        src[0].setRate(ASSET, 20 * PCT);
        src[1].setRate(ASSET, 40 * PCT);
        rr.update(ASSET);
        vm.expectRevert(abi.encodeWithSelector(RateReference.SeriesNotWarm.selector, id, uint64(now_), true));
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));

        // An agreeing update warms it, and it opens.
        src[0].setRate(ASSET, 5 * PCT);
        src[1].setRate(ASSET, 5 * PCT);
        _warp(15 minutes);
        rr.update(ASSET);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        assertEq(rr.newestSeries(ASSET), id);
    }

    function test_Start_FewerThanThreeSourcesRefused() public {
        IRateReference.SeriesConfig memory c = _cfg(2);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RateReference.InvalidSeriesConfig.selector, uint8(0)));
        rr.proposeSeries(ASSET, c);
    }

    function test_Start_NoAgreedReadingRefused() public {
        src[0].setRate(ASSET, 1 * PCT);
        src[1].setRate(ASSET, 10 * PCT);
        src[2].setRate(ASSET, 20 * PCT);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(RateReference.NoStartingReference.selector, ASSET, IRateReference.Outcome.HeldNoAgreement)
        );
        rr.proposeSeries(ASSET, _cfg(3));
    }

    // ─── 7. Delayed changes, bounds, mutes ───────────────────────────────

    function test_Changes_DelayAndBounds() public {
        RateReference prod;
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(RateReference.DelayOutOfRange.selector, 0, 7 days, 14 days));
        prod = new RateReference(owner, guardian, diamond, 0);
        prod = new RateReference(owner, guardian, diamond, 7 days);
        vm.prank(owner);
        prod.proposeChange(IRateReference.Kind.StalenessIntervals, bytes32(uint256(4)));
        vm.expectRevert();
        prod.executeChange(IRateReference.Kind.StalenessIntervals, bytes32(0));
        _warp(7 days);
        prod.executeChange(IRateReference.Kind.StalenessIntervals, bytes32(0));
        assertEq(prod.settings().stalenessIntervals, 4);
        vm.prank(owner);
        vm.expectRevert();
        prod.proposeChange(IRateReference.Kind.StalenessIntervals, bytes32(uint256(13)));
        vm.prank(owner);
        vm.expectRevert();
        prod.proposeChange(IRateReference.Kind.WeightTable, bytes32(_pack([uint16(10_000), 7_500, 8_000, 2_500, 1_000])));
    }

    function test_Mute_UnmuteWaitsAndNewSeriesMovesWhileOldHolds() public {
        uint32 first = _open(4);
        vm.prank(diamond);
        rr.noteLoanOpened(ASSET, 0, 0);
        IRateReference.Source memory s3 = IRateReference.Source(address(src[3]), address(src[3]), bytes32(0));
        vm.prank(guardian);
        rr.mute(ASSET, s3);
        uint32 second = _open(3); // sources 0..2 only
        _setAll(6 * PCT);
        _hourly(2);
        assertTrue(rr.seriesOf(first).holding, "old series lists the muted source");
        assertFalse(rr.seriesOf(second).holding, "new series moves for new loans");
        assertEq(rr.seriesOf(first).referenceRate, 5 * PCT);
        vm.prank(owner);
        rr.proposeUnmute(ASSET, s3);
        rr.executeChange(IRateReference.Kind.Unmute, rr.sourceKey(ASSET, s3)); // testnet delay 0
        _hourly(1);
        assertFalse(rr.seriesOf(first).holding);
    }

    function test_Mute_OnlyOwnerOrGuardian() public {
        _open(3);
        IRateReference.Source memory s0 = IRateReference.Source(address(src[0]), address(src[0]), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(RateReference.NotOwnerOrGuardian.selector, address(this)));
        rr.mute(ASSET, s0);
    }

    // ─── 8. Readers ──────────────────────────────────────────────────────

    function test_Readers_ConvertToSimpleAnnual() public {
        RayMarketMock m1 = new RayMarketMock();
        m1.set(4e25); // 4% a year at 1e27
        (bool ok, uint256 r) = new AnnualRayRateReader().readRate(ASSET, address(m1), bytes32(0));
        assertTrue(ok);
        assertEq(r, 4 * PCT);
        UtilisationMarketMock m2 = new UtilisationMarketMock(ASSET);
        m2.set(1585489599); // ~5% a year per second at 1e18
        PerSecondUtilisationRateReader r2 = new PerSecondUtilisationRateReader();
        (ok, r) = r2.readRate(ASSET, address(m2), bytes32(0));
        assertTrue(ok);
        assertEq(r, uint256(1585489599) * 365 days);
        (ok,) = r2.readRate(address(0xBEEF), address(m2), bytes32(0));
        assertFalse(ok, "another asset than the market's reads as failed");
    }

    function test_MockSourceRefusedOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(MockRateSource.NotATestnet.selector, uint256(1)));
        new MockRateSource(address(this));
    }

    // ─── 9. Minimum spacing ──────────────────────────────────────────────

    function test_MinSpacing_EarlyUpdateChangesNothing() public {
        uint32 id = _open(3);
        _setAll(9 * PCT);
        _warp(10 minutes);
        rr.update(ASSET);
        assertEq(rr.seriesOf(id).lastUpdate, now_ - 10 minutes);
        assertEq(_ref(), 5 * PCT);
    }

    // ─── 10. Series ──────────────────────────────────────────────────────

    function test_Series_OldLoanAccruesAsIfNoChange_UpdateWritesLiveOnly() public {
        uint32 first = _open(3);
        vm.prank(diamond);
        (uint32 got,,) = rr.noteLoanOpened(ASSET, 0, 0);
        assertEq(got, first);
        IRateReference.SeriesConfig memory c = _cfg(4);
        c.stepBpsPerHour = 100;
        vm.prank(owner);
        uint32 second = rr.proposeSeries(ASSET, c);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        assertEq(rr.newestSeries(ASSET), second);
        _setAll(6 * PCT);
        _hourly(1);
        assertEq(rr.seriesOf(first).referenceRate, 5 * PCT + 50 * 1e14, "old series keeps its own step");
        assertEq(rr.seriesOf(second).referenceRate, 6 * PCT, "new series its own");
        // The last loan closes: the old series is no longer written.
        vm.prank(diamond);
        rr.noteLoanClosed(first, 0, 0);
        uint64 last = rr.seriesOf(first).lastUpdate;
        _hourly(1);
        assertEq(rr.seriesOf(first).lastUpdate, last);
    }

    function test_Series_LiveBoundRefusesOneMore() public {
        _open(3);
        vm.prank(diamond);
        rr.noteLoanOpened(ASSET, 0, 0);
        _open(3);
        vm.prank(diamond);
        rr.noteLoanOpened(ASSET, 0, 0);
        _open(3);
        vm.prank(diamond);
        rr.noteLoanOpened(ASSET, 0, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RateReference.TooManyLiveSeries.selector, ASSET, 4, 3));
        rr.proposeSeries(ASSET, _cfg(3));
    }

    function test_Series_OnlyDiamondMovesLoanCount() public {
        _open(3);
        vm.expectRevert(abi.encodeWithSelector(RateReference.NotDiamond.selector, address(this)));
        rr.noteLoanOpened(ASSET, 0, 0);
    }

    // ─── #3713: windows, unusual, term average, band ─────────────────────

    function test_LongWindowContinuesIntoPreviousSeries_24hDoesNot() public {
        _open(3);
        _hourly(24 * 8);
        _open(4);
        _hourly(2);
        (bool ok7,,) = rr.averaged(ASSET, 7 days);
        (bool ok24,,) = rr.averaged(ASSET, 24 hours);
        assertTrue(ok7, "the 7-day read continues into the previous series");
        assertFalse(ok24, "the 24-hour read waits for the new series' own day");
    }

    /// A long window spanning two series changes continues through both
    /// predecessors and equals the uninterrupted average.
    function test_LongWindowContinuesAcrossSeveralSeriesChanges() public {
        _open(3);
        _hourly(24 * 25);
        _open(4);
        _hourly(24 * 7);
        _open(5);
        _hourly(24);
        (bool ok, uint256 avg,) = rr.averaged(ASSET, 30 days);
        assertTrue(ok, "the 30-day read continues back two series");
        assertEq(avg, 5 * PCT);
    }

    function test_DailyCheckpointFoundAcrossMissedHours() public {
        _open(3);
        // Update every 3 hours with a 6-hour interval series would be
        // needed to skip hours; here we update hourly for 9 days then check
        // a 7-day read finds a checkpoint.
        _hourly(24 * 9);
        (bool ok, uint256 avg,) = rr.averaged(ASSET, 7 days);
        assertTrue(ok);
        assertEq(avg, 5 * PCT);
    }

    /// A series on the longest permitted interval (6 hours), updated on
    /// time at 00:00, 06:00, 12:00 and 18:00, stays readable for a short
    /// window at every hour: the hourly search reaches back across one whole
    /// interval, so it never falls through to a day checkpoint that is too
    /// old (Codex #3782 r7).
    function test_ShortWindowReadableAtEveryHourOnLongestInterval() public {
        IRateReference.SeriesConfig memory c = _cfg(3);
        c.interval = uint32(rr.INTERVAL_MAX());
        vm.prank(owner);
        rr.proposeSeries(ASSET, c);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        // Align to a UTC midnight, then update every six hours for three days.
        _warp((now_ / 1 days + 1) * 1 days - now_);
        for (uint256 i; i < 12; ++i) {
            rr.update(ASSET);
            _warp(6 hours);
        }
        rr.update(ASSET); // 00:00 of day four
        for (uint256 h = 1; h < 6; ++h) {
            _warp(1 hours);
            (bool ok, uint256 avg, IRateReference.AvgReason why) = rr.averaged(ASSET, 12 hours);
            assertTrue(ok, "a punctual 6-hour series is readable over 12 hours at every hour");
            assertEq(uint8(why), uint8(IRateReference.AvgReason.Ok));
            assertEq(avg, 5 * PCT);
        }
    }

    function test_Unusual_EntersAtDistance_TermAverageAndBand() public {
        _open(3);
        _hourly(24 * 31);
        assertEq(uint8(_rd().unusual(ASSET)), uint8(IRateReference.Unusual.Calm));
        // Spike: 5% -> 15% (step 0.5/h -> 20 hours).
        _setAll(15 * PCT);
        _hourly(48);
        assertEq(uint8(_rd().unusual(ASSET)), uint8(IRateReference.Unusual.Unusual));
        // Long linked fills pause; short ones proceed.
        (, IRateReference.LinkRefusal why) = _rd().linkedRate(ASSET, 90, IRateReference.LinkKind.Reference);
        assertEq(uint8(why), uint8(IRateReference.LinkRefusal.ReferenceUnusual));
        (uint256 r7, IRateReference.LinkRefusal why7) = _rd().linkedRate(ASSET, 7, IRateReference.LinkKind.Reference);
        assertEq(uint8(why7), uint8(IRateReference.LinkRefusal.None));
        assertGt(r7, 10 * PCT);
        // In a spike the one-year term average sits below the 24-hour average.
        IRateReference.TermAverage memory y = _rd().termAverage(ASSET, 365);
        assertTrue(y.available);
        assertEq(y.weightBps, 1_000);
        assertLt(y.rate1e18, y.average24h);
        // Band: 15% for a year against an average near 6% is far above.
        IRateReference.Band memory b = _rd().band(ASSET, 365, 1500);
        assertTrue(b.outside && b.above);
        IRateReference.Band memory inside = _rd().band(ASSET, 7, 1500);
        assertFalse(inside.outside, "a week's average is today's 15%");
    }

    function test_Weights_RowsAndBetween() public view {
        assertEq(_rd().weightBps(1), 10_000);
        assertEq(_rd().weightBps(7), 10_000);
        assertEq(_rd().weightBps(30), 7_500);
        assertEq(_rd().weightBps(60), 6_250);
        assertEq(_rd().weightBps(365), 1_000);
        assertEq(_rd().weightBps(1000), 1_000);
    }

    function test_Band_NoAverageNoBand() public view {
        IRateReference.Band memory b = _rd().band(ASSET, 30, 9_000);
        assertFalse(b.available);
        assertFalse(b.outside);
    }

    function test_Band_MinDistance() public {
        _open(3);
        _setAll(1 * PCT);
        _hourly(24 * 31 + 24 * 60);
        // 2.5% vs 1%: 2.5x but only 1.5 points away -> inside.
        assertFalse(_rd().band(ASSET, 7, 250).outside);
        // 3.5% vs 1%: 2.5 points away and over 1.5x -> outside.
        assertTrue(_rd().band(ASSET, 7, 350).outside);
    }

    function _pack(uint16[5] memory w) internal pure returns (uint256 v) {
        for (uint256 i; i < 5; ++i) {
            v |= uint256(w[i]) << (16 * i);
        }
    }

    // ─── Cap and floor levels (#3337 part 2, levels design section 9) ────

    function _levelSubject(uint16 rateBps, bool isCap) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(ASSET)) | (uint256(rateBps) << 160) | (isCap ? uint256(1) << 176 : 0));
    }

    function _level(uint16 rateBps, bool isCap) internal returns (uint32 id) {
        vm.prank(owner);
        rr.proposeLevel(ASSET, rateBps, isCap);
        rr.executeChange(IRateReference.Kind.AddLevel, _levelSubject(rateBps, isCap));
        id = rr.levelCount();
    }

    function _retireLevel(uint32 id) internal {
        vm.prank(owner);
        rr.proposeRetireLevel(id);
        rr.executeChange(IRateReference.Kind.RetireLevel, bytes32(uint256(id)));
    }

    function _openLoan(uint32 cap, uint32 floor_) internal returns (uint32 id, uint256 snap) {
        vm.prank(diamond);
        (id, snap,) = rr.noteLoanOpened(ASSET, cap, floor_);
    }

    function test_Reads_CompanionNamesThisReference() public view {
        assertEq(address(_rd().REFERENCE()), address(rr));
        assertTrue(rr.READS() != address(0));
    }

    function test_Levels_NoLevelsReadsTheIndex() public {
        uint32 id = _open(3);
        _hourly(3);
        (uint256 c,) = rr.clampedSum(id, 0, 0);
        assertEq(c, _rd().status(ASSET).index);
    }

    function test_Levels_CapBelowAndAboveTheReference() public {
        uint32 id = _open(3);
        uint32 low = _level(400, true); // 4%: the 5% reference is above it
        uint32 high = _level(800, true); // 8%: never reached
        (, uint256 s0) = _openLoan(low, 0);
        (, uint256 h0) = _openLoan(high, 0);
        _hourly(10);
        _warp(30 minutes); // a part interval, carried at the reference in force
        (uint256 s1,) = rr.clampedSum(id, low, 0);
        (uint256 h1,) = rr.clampedSum(id, high, 0);
        assertEq(s1 - s0, 4 * PCT * (10 hours + 30 minutes), "held at the cap");
        assertEq(h1 - h0, 5 * PCT * (10 hours + 30 minutes), "a cap above the reference changes nothing");
        (uint256 hTotal,) = rr.levelOnSeries(id, high);
        assertEq(hTotal, 0, "nothing written for a level the reference is inside");
    }

    function test_Levels_FloorMirror() public {
        uint32 id = _open(3);
        uint32 fl = _level(600, false); // 6%: the reference is below it
        (, uint256 s0) = _openLoan(0, fl);
        _hourly(4);
        (uint256 s1,) = rr.clampedSum(id, 0, fl);
        assertEq(s1 - s0, 6 * PCT * 4 hours, "held at the floor");
    }

    function test_Levels_CrossingTheCapIsExactToTheUpdates() public {
        uint32 id = _open(3);
        uint32 cap = _level(525, true); // 5.25%
        (, uint256 s0) = _openLoan(cap, 0);
        _setAll(6 * PCT);
        _hourly(1); // accrues 5.00 for the hour, then the reference steps to 5.50
        _hourly(1); // accrues 5.50 cut to 5.25
        (uint256 s1,) = rr.clampedSum(id, cap, 0);
        assertEq(s1 - s0, (5 * PCT + 525 * 1e14) * 1 hours);
    }

    function test_Levels_CapAndFloorOnOnePath() public {
        uint32 id = _open(3);
        uint32 cap = _level(550, true);
        uint32 fl = _level(450, false);
        (, uint256 s0) = _openLoan(cap, fl);
        // Down to 4.0 (below the floor), then up to 6.0 (above the cap).
        // The step is 0.5 a hour, so the reference in force each hour is
        // 5.0, 4.5, 4.0, 4.0 | 4.5, 5.0, 5.5, 6.0, and each hour accrues the
        // one before the update: clamped to 5.0, 4.5, 4.5, 4.5, 4.5, 5.0,
        // 5.5, 5.5 = 39.0 percent-hours.
        _setAll(4 * PCT);
        _hourly(3);
        _setAll(6 * PCT);
        _hourly(5);
        (uint256 s1,) = rr.clampedSum(id, cap, fl);
        assertEq(s1 - s0, 39 * PCT * 1 hours, "clamped path");
    }

    function test_Levels_TwoLoansEachFromTheirOwnSnapshot() public {
        uint32 id = _open(3);
        uint32 cap = _level(400, true);
        (, uint256 a0) = _openLoan(cap, 0);
        _hourly(2);
        (, uint256 b0) = _openLoan(cap, 0);
        _hourly(3);
        (uint256 now1,) = rr.clampedSum(id, cap, 0);
        assertEq(now1 - a0, 4 * PCT * 5 hours);
        assertEq(now1 - b0, 4 * PCT * 3 hours);
        (, uint32 loans) = rr.levelOnSeries(id, cap);
        assertEq(loans, 2);
    }

    function test_Levels_RetiredKeepsAccruingUntilTheLastLoanCloses() public {
        uint32 id = _open(3);
        uint32 cap = _level(400, true);
        (, uint256 s0) = _openLoan(cap, 0);
        _retireLevel(cap);
        vm.prank(diamond);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelNotOpen.selector, cap));
        rr.noteLoanOpened(ASSET, cap, 0);
        _hourly(2);
        (uint256 s1,) = rr.clampedSum(id, cap, 0);
        assertEq(s1 - s0, 4 * PCT * 2 hours, "still in force for the open loan");
        assertEq(rr.trackedLevels(ASSET).length, 1);
        vm.prank(diamond);
        rr.noteLoanClosed(id, cap, 0);
        assertEq(rr.trackedLevels(ASSET).length, 0, "no longer tracked");
    }

    function test_Levels_AddedLaterStartsAtZero() public {
        uint32 id = _open(3);
        _hourly(5);
        uint32 cap = _level(400, true);
        (uint256 total,) = rr.levelOnSeries(id, cap);
        assertEq(total, 0);
        (uint32 sid, uint256 s0) = _openLoan(cap, 0);
        assertEq(sid, id);
        (uint256 c,) = rr.clampedSum(id, cap, 0);
        assertEq(c, s0, "the snapshot is the clamped sum now");
        _hourly(1);
        (c,) = rr.clampedSum(id, cap, 0);
        assertEq(c - s0, 4 * PCT * 1 hours);
    }

    function test_Levels_OpenRefusals() public {
        uint32 id = _open(3);
        uint32 cap = _level(600, true);
        uint32 fl = _level(400, false);
        vm.startPrank(diamond);
        vm.expectRevert(abi.encodeWithSelector(RateReference.UnknownLevel.selector, uint32(99)));
        rr.noteLoanOpened(ASSET, 99, 0);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelWrongSide.selector, fl, false));
        rr.noteLoanOpened(ASSET, fl, 0);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelWrongSide.selector, cap, true));
        rr.noteLoanOpened(ASSET, 0, cap);
        vm.stopPrank();
        // A floor not below the series ceiling, uncapped.
        IRateReference.SeriesConfig memory c = _cfg(3);
        c.ceilingBps = 400;
        vm.prank(owner);
        rr.proposeSeries(ASSET, c);
        rr.executeChange(IRateReference.Kind.OpenSeries, bytes32(uint256(uint160(ASSET))));
        vm.prank(diamond);
        vm.expectRevert(abi.encodeWithSelector(RateReference.FloorNotBelowCap.selector, uint16(400), uint16(400)));
        rr.noteLoanOpened(ASSET, 0, fl);
        id;
    }

    function test_Levels_OpenRefusesAStaleSeries() public {
        uint32 id = _open(3);
        _warp(4 hours); // three intervals is the default limit
        vm.prank(diamond);
        vm.expectRevert(abi.encodeWithSelector(RateReference.SeriesStale.selector, id, uint64(now_ - 4 hours), false));
        rr.noteLoanOpened(ASSET, 0, 0);
    }

    function test_Levels_OtherAssetsLevelRefused() public {
        _open(3);
        address other = address(0xB0B);
        vm.prank(owner);
        rr.proposeLevel(other, 600, true);
        rr.executeChange(
            IRateReference.Kind.AddLevel,
            bytes32(uint256(uint160(other)) | (uint256(600) << 160) | (uint256(1) << 176))
        );
        uint32 lv = rr.levelCount();
        vm.prank(diamond);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelForOtherAsset.selector, lv, ASSET));
        rr.noteLoanOpened(ASSET, lv, 0);
    }

    function test_Levels_ListRule() public {
        _level(600, true);
        _level(400, false);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(0), true, uint8(1)));
        rr.proposeLevel(ASSET, 0, true);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(10_001), true, uint8(1)));
        rr.proposeLevel(ASSET, 10_001, true);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(600), false, uint8(4)));
        rr.proposeLevel(ASSET, 600, false); // a floor at a tracked cap
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(400), true, uint8(4)));
        rr.proposeLevel(ASSET, 400, true); // a cap at a tracked floor
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(600), true, uint8(5)));
        rr.proposeLevel(ASSET, 600, true);
        vm.stopPrank();
        _level(700, true);
        _level(800, true);
        _level(900, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(1000), true, uint8(2)));
        rr.proposeLevel(ASSET, 1000, true);
    }

    function test_Levels_TrackedBoundHoldsWithRetiredLoans() public {
        uint32 id = _open(3);
        // Four open caps, each with a loan, retired; then four more; then none.
        for (uint16 i; i < 4; ++i) {
            uint32 lv = _level(600 + i * 100, true);
            _openLoan(lv, 0);
            _retireLevel(lv);
        }
        for (uint16 i; i < 4; ++i) {
            _level(1100 + i * 100, true);
        }
        assertEq(rr.trackedLevels(ASSET).length, 8);
        _retireLevel(rr.levelCount()); // no loan: untracked at once, frees a slot
        uint32 last = _level(2000, true);
        _openLoan(last, 0);
        _retireLevel(last); // three open, eight tracked: the tracked bound binds
        assertEq(rr.trackedLevels(ASSET).length, 8);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RateReference.LevelRefused.selector, ASSET, uint16(2100), true, uint8(3)));
        rr.proposeLevel(ASSET, 2100, true);
        id;
    }

    function test_Levels_OnlyTheDiamondCountsAndOnlyTheOwnerProposes() public {
        _open(3);
        vm.expectRevert(abi.encodeWithSelector(RateReference.NotDiamond.selector, address(this)));
        rr.noteLoanClosed(1, 0, 0);
        vm.expectRevert();
        rr.proposeLevel(ASSET, 600, true);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(RateReference.InvalidChange.selector, IRateReference.Kind.AddLevel, bytes32(0), bytes32(0))
        );
        rr.proposeChange(IRateReference.Kind.AddLevel, bytes32(0));
    }
}
