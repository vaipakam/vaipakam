// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";

/**
 * @title  RecycleSurplusFlagTest
 * @notice #1222 M4 C1 (#1567) — the per-chain surplus flag.
 *
 *         `VpfiCrossChainRecyclingDesign.md` §3.6: *"If a chain's
 *         `availRecycled` exceeds a governance knob (e.g. N x its trailing
 *         30-day average daily budget), the surplus is flagged
 *         operator-visible."*
 *
 *         Flagging only. **Nothing moves** — disposition is C2 (#1568).
 *
 *         The properties that needed pinning, as opposed to re-asserting the
 *         arithmetic:
 *
 *           1. DARK by default (`N == 0`), and dark is distinguishable from
 *              "budgeted nothing" even though both report `threshold == 0`.
 *           2. The BOUNDARY: at exactly `N x` the average it does NOT flag;
 *              one wei past it does. Driven deterministically, not fuzzed.
 *           3. The divisor is the FULL window, so unstamped days dilute.
 *              A test that divided by stamped-days-only would pass every
 *              other assertion here.
 *           4. A zero trailing average with live availability FLAGS — the
 *              case a naive zero-denominator guard silently suppresses, and
 *              the strongest surplus signal there is.
 *           5. The window is bounded: a day older than it cannot influence
 *              the average.
 *
 *         Every read goes through the DIAMOND. `LibVaipakam.storageSlot()`
 *         called from a test contract resolves against the TEST's own
 *         storage, so an assertion written that way compares 0 to 0 and
 *         passes regardless of what the Diamond holds.
 */
contract RecycleSurplusFlagTest is SetupTest {
    MockRewardMessenger internal messenger;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    /// Day the trailing window ends on. Comfortably past the window width so
    /// `throughDay - i` never reaches the pre-launch prefix branch except
    /// where a test means to exercise it.
    uint256 internal constant THROUGH_DAY = 100;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// Give ARB `amount` of recycled availability through the REAL ingress.
    /// With nothing consumed or released, `avail == reported`.
    /// @dev `dayId` must differ per call — the ingress rejects a re-report of
    ///      the same `(day, chain)` — and `amount` must not decrease, since
    ///      the reported cumulative is a monotonic ratchet.
    function _seedAvail(uint256 dayId, uint256 amount) internal {
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, dayId, 20e18, 10e18, amount, amount
        );
    }

    /// Stamp `dayCount` consecutive days ending at THROUGH_DAY, each carrying
    /// `perSide` on BOTH sides — so each contributes `2 x perSide` to the sum.
    function _seedFundedDays(uint256 dayCount, uint256 perSide) internal {
        for (uint256 i; i < dayCount; ++i) {
            _mut().setChainDayFundingRaw(
                THROUGH_DAY - i, CHAIN_ARB, 0, perSide
            );
        }
    }

    function _pos()
        internal
        view
        returns (
            uint256 avail,
            uint256 avg,
            uint256 threshold,
            uint16 multiple,
            bool flagged
        )
    {
        return _agg().getChainSurplusPosition(CHAIN_ARB, THROUGH_DAY);
    }

    // ─── 1. Dark by default ──────────────────────────────────────────────

    /// The deploy default is `N == 0` and nothing flags, however lopsided the
    /// position. An ops flag that fires before an operator has chosen a
    /// threshold trains people to ignore it.
    function test_DarkByDefault_NeverFlags() public {
        _seedAvail(1, 1_000 ether);
        _seedFundedDays(30, 1 ether); // avg = 2/day vs 1000 held: wildly over

        (
            uint256 avail,
            uint256 avg,
            uint256 threshold,
            uint16 multiple,
            bool flagged
        ) = _pos();

        assertEq(multiple, 0, "deploy default is dark");
        assertEq(avail, 1_000 ether, "availability still reported while dark");
        assertEq(avg, 2 ether, "average still computed while dark");
        assertEq(threshold, 0, "no threshold while dark");
        assertFalse(flagged, "dark never flags");
    }

    /// `threshold == 0` is ambiguous ALONE — it means either dark, or the
    /// chain budgeted nothing all window. Those are OPPOSITE situations, and
    /// `multiple` is what separates them. A consumer keying on
    /// `threshold == 0` would conflate the strongest surplus case with the
    /// feature being switched off.
    function test_ZeroThreshold_NeedsMultipleToDisambiguate() public {
        _seedAvail(1, 500 ether);

        // (a) dark, with real demand behind it.
        _seedFundedDays(30, 1 ether);
        (, uint256 avgDark, uint256 tDark, uint16 mDark, bool fDark) = _pos();
        assertEq(tDark, 0, "dark reports zero threshold");
        assertEq(mDark, 0, "and zero multiple, which is what says DARK");
        assertFalse(fDark, "dark does not flag");
        assertGt(avgDark, 0, "while the average is genuinely non-zero");

        // (b) armed, but the chain budgeted nothing across the whole window.
        _agg().setRecycleSurplusMultiple(30);
        for (uint256 i; i < 30; ++i) {
            _mut().setChainDayFundingRaw(THROUGH_DAY - i, CHAIN_ARB, 0, 0);
        }
        (, uint256 avgIdle, uint256 tIdle, uint16 mIdle, bool fIdle) = _pos();
        assertEq(tIdle, 0, "idle chain also reports zero threshold");
        assertEq(avgIdle, 0, "because its average really is zero");
        assertEq(mIdle, 30, "but the multiple is set, so this is NOT dark");
        assertTrue(fIdle, "and it DOES flag: same threshold, opposite meaning");
    }

    // ─── 2. The boundary ─────────────────────────────────────────────────

    /// AT the threshold is not surplus; one wei past it is. Driven to the
    /// exact boundary rather than "comfortably over", because a `>=` / `>`
    /// slip is invisible to any test that only checks a wide margin.
    function test_Boundary_AtThresholdDoesNotFlag_OneWeiPastDoes() public {
        // 30 days x 2 ether/day = 60 ether total, avg = 2 ether.
        _seedFundedDays(30, 1 ether);
        _agg().setRecycleSurplusMultiple(10); // threshold = 20 ether

        _seedAvail(1, 20 ether);
        (, uint256 avg, uint256 threshold, , bool atFlag) = _pos();
        assertEq(avg, 2 ether, "trailing average");
        assertEq(threshold, 20 ether, "N x average");
        assertFalse(atFlag, "exactly AT the threshold is not surplus");

        // Reported is a monotonic ratchet, so advance it by one wei on a
        // later day.
        _seedAvail(2, 20 ether + 1);
        (uint256 avail2, , , , bool overFlag) = _pos();
        assertEq(avail2, 20 ether + 1, "availability advanced by one wei");
        assertTrue(overFlag, "one wei past the threshold IS surplus");
    }

    // ─── 3. The divisor is the full window ───────────────────────────────

    /// One busy day in an otherwise idle month must NOT masquerade as a month
    /// of demand. If the divisor were "days that happened to be stamped",
    /// this fixture's average would be 60 ether rather than 2 ether — a 30x
    /// overstatement that would suppress a real surplus flag.
    function test_UnstampedDaysDilute_DivisorIsTheWholeWindow() public {
        // A single stamped day carrying the whole month's budget.
        _mut().setChainDayFundingRaw(THROUGH_DAY, CHAIN_ARB, 0, 30 ether);

        (, uint256 avg, , , ) = _pos();
        assertEq(
            avg,
            60 ether / LibVaipakam.RECYCLE_SURPLUS_WINDOW_DAYS,
            "one 60-ether day over a 30-day window averages to 2 ether"
        );
        assertEq(avg, 2 ether, "stated concretely, so the intent is legible");

        // The dilution is load-bearing: at N=10 the threshold is 20 ether, so
        // 25 ether held flags. Divided by stamped-days-only the threshold
        // would be 600 ether and this would stay silent.
        _agg().setRecycleSurplusMultiple(10);
        _seedAvail(1, 25 ether);
        (, , uint256 threshold, , bool flagged) = _pos();
        assertEq(threshold, 20 ether, "diluted threshold");
        assertTrue(flagged, "a real surplus is not hidden by one busy day");
    }

    // ─── 4. Zero average with live availability ──────────────────────────

    /// A chain holding funds while budgeting nothing for the whole window is
    /// the STRONGEST surplus case, not an undefined one. The natural
    /// zero-denominator guard (`if (avg == 0) return false`) silently
    /// suppresses exactly this.
    function test_ZeroAverage_WithAvailability_Flags() public {
        _agg().setRecycleSurplusMultiple(30);
        _seedAvail(1, 1 ether); // no funded days stamped at all

        (
            uint256 avail,
            uint256 avg,
            uint256 threshold,
            ,
            bool flagged
        ) = _pos();
        assertEq(avail, 1 ether, "holds funds");
        assertEq(avg, 0, "budgeted nothing across the window");
        assertEq(threshold, 0, "so the threshold is zero");
        assertTrue(flagged, "and that is surplus, not undefined");
    }

    /// The mirror image: no availability and no demand is NOT surplus.
    /// Guards against "flag whenever the average is zero".
    function test_ZeroAverage_WithoutAvailability_DoesNotFlag() public {
        _agg().setRecycleSurplusMultiple(30);

        (uint256 avail, , , , bool flagged) = _pos();
        assertEq(avail, 0, "nothing held");
        assertFalse(flagged, "nothing held is never surplus");
    }

    // ─── 5. The window is bounded ────────────────────────────────────────

    /// A day older than the window cannot influence the average. Without the
    /// bound, ancient demand would keep suppressing the flag forever.
    function test_DayOlderThanWindow_IsExcluded() public {
        uint256 window = LibVaipakam.RECYCLE_SURPLUS_WINDOW_DAYS;

        // Just outside the window.
        _mut().setChainDayFundingRaw(
            THROUGH_DAY - window, CHAIN_ARB, 0, 500 ether
        );
        (, uint256 avgExcluded, , , ) = _pos();
        assertEq(avgExcluded, 0, "a day one past the window contributes nothing");

        // The oldest day still INSIDE it does count.
        _mut().setChainDayFundingRaw(
            THROUGH_DAY - (window - 1), CHAIN_ARB, 0, 15 ether
        );
        (, uint256 avgIncluded, , , ) = _pos();
        assertEq(
            avgIncluded,
            30 ether / window,
            "the oldest in-window day is counted"
        );
        assertGt(avgIncluded, 0, "and it is genuinely non-zero");
    }

    /// The pre-launch prefix zero-pads rather than reverting: a window
    /// reaching back past day 0 must not underflow, and the divisor stays the
    /// full window (so a young chain reads conservatively low, never high).
    function test_PreLaunchPrefix_ZeroPadsWithoutReverting() public {
        _mut().setChainDayFundingRaw(2, CHAIN_ARB, 0, 15 ether);

        (, uint256 avg, , , ) = _agg().getChainSurplusPosition(CHAIN_ARB, 2);
        assertEq(
            avg,
            30 ether / LibVaipakam.RECYCLE_SURPLUS_WINDOW_DAYS,
            "days before launch pad with zero; divisor stays the full window"
        );
    }

    // ─── The knob itself ─────────────────────────────────────────────────

    function test_Knob_BoundedAbove_AndZeroIsDarkNotDefault() public {
        uint16 max = LibVaipakam.RECYCLE_SURPLUS_MULTIPLE_MAX;

        // Bounded above, so a fat-fingered value cannot silently make the
        // flag unreachable instead of erroring.
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardAggregatorFacet.InvalidRecycleSurplusMultiple.selector,
                uint16(max + 1),
                max
            )
        );
        _agg().setRecycleSurplusMultiple(max + 1);

        // The bound itself is accepted, and readable back THROUGH THE DIAMOND.
        _agg().setRecycleSurplusMultiple(max);
        (, , , uint16 atMax, ) = _pos();
        assertEq(atMax, max, "the bound is a legal value");

        // `0` turns it back OFF rather than resetting to some default — the
        // distinction that separates this knob from `setRecycleMarginBps`.
        _agg().setRecycleSurplusMultiple(0);
        (, , , uint16 backToDark, ) = _pos();
        assertEq(backToDark, 0, "zero is DARK, not reset-to-default");
    }

    function test_Knob_RejectsNonAdmin() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert();
        _agg().setRecycleSurplusMultiple(30);
    }

    // ─── Read-only ───────────────────────────────────────────────────────

    /// C1 flags; it never moves value. Pinned because the design rests on
    /// disposition staying deliberate (C2/#1568), so a future edit that
    /// "helpfully" swept a flagged surplus would be caught here.
    function test_FlaggingMovesNothing() public {
        _agg().setRecycleSurplusMultiple(1);
        _seedAvail(1, 100 ether);
        _seedFundedDays(30, 1 ether);

        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        (, , , uint256 attributedBefore) =
            _agg().getChainRecycledLedger(CHAIN_ARB);

        (uint256 avail, , , , bool flagged) = _pos();
        assertTrue(flagged, "fixture is genuinely flagged");

        (
            uint256 reportedAfter,
            uint256 consumedAfter,
            uint256 availAfter,
            uint256 attributedAfter
        ) = _agg().getChainRecycledLedger(CHAIN_ARB);

        assertEq(_mut().getRecycleBucketRaw(), bucketBefore, "bucket untouched");
        assertEq(consumedAfter, 0, "nothing consumed");
        assertEq(availAfter, avail, "availability untouched");
        assertEq(reportedAfter, 100 ether, "reported untouched");
        assertEq(attributedAfter, attributedBefore, "attribution untouched");
    }
}
