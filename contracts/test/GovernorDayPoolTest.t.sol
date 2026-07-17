// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";

/**
 * @title  GovernorDayPoolTest
 * @notice Governor PR-3b (#1217 §3.1) — the day-pool stamp written at
 *         finalization. Proves the ratified formula end-to-end on the real
 *         `finalizeDay` path:
 *
 *           Ā[D]           = Σ_{d∈(D−7..D]} credited[d] / 7  (zero-padded)
 *           scheduleFloor  = min(schedule, freshAvailable)
 *           recycledBudget = schedule==0 ? 0 : min(fundable, Ā×(1−m))
 *
 *         plus the snapshot discipline (a margin retune after finalization
 *         never rewrites a stamped day) and the commitment arming gate
 *         (records-only while `governorCommitArmedFromDay == 0`; armed
 *         stamps reserve into the outstanding sums).
 */
contract GovernorDayPoolTest is SetupTest {
    MockRewardMessenger internal messenger;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        _configureCanonical();
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _configureCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
    }

    /// @dev Deliver full coverage for `dayId` and finalize it.
    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 20e18, 10e18);
        _agg().finalizeDay(dayId);
    }

    function _schedule(uint256 dayId) internal view returns (uint256) {
        return LibInteractionRewards.halfPoolForDay(dayId) * 2;
    }

    // ─── The formula ─────────────────────────────────────────────────────────

    function testStampMatchesRatifiedFormula() public {
        // Seed the bucket + one credited day inside the trailing window:
        // credited[3] = 700 VPFI → Ā[5] = 700/7 = 100 (zero-padded ÷7).
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(3, 700 ether);

        _finalize(5);

        (
            bool stamped,
            uint256 scheduleFloor,
            uint256 recycledBudget,
            uint256 aBar,
            uint256 marginBps
        ) = _agg().getDayPoolStamp(5);

        assertTrue(stamped, "stamped at finalize");
        assertEq(aBar, 100 ether, "trailing average zero-pads and divides by 7");
        assertEq(marginBps, 500, "default 5% margin stamped");
        assertEq(scheduleFloor, _schedule(5), "floor = schedule (pool untouched)");
        // recycled = min(fundable, 100 x 95%) = 95 VPFI (bucket is ample).
        assertEq(recycledBudget, 95 ether, "coupled term at 1-minus-margin");
        // Records-only: reservation is unarmed by default.
        (uint256 armed, uint256 outF, uint256 outR, ) =
            _agg().getGovernorCommitState();
        assertEq(armed, 0, "unarmed by default");
        assertEq(outF, 0, "no fresh reservation while unarmed");
        assertEq(outR, 0, "no recycled reservation while unarmed");
    }

    function testFundableClampsRecycledBudget() public {
        // Ā = 100 but the bucket holds only 30 → recycled = 30.
        _mut().setRecycleBucketRaw(30 ether);
        _mut().setRecycledCreditedByDayRaw(4, 700 ether);

        _finalize(5);

        (, , uint256 recycledBudget, , ) = _agg().getDayPoolStamp(5);
        assertEq(recycledBudget, 30 ether, "fundable (bucket) clamps the term");
    }

    function testDayZeroScheduleGatesRecycledTermOff() public {
        // Day 0 stays reward-excluded — recycling must not make day-0
        // activity rewardable (schedule==0 ⇒ recycled forced 0 too).
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(0, 7_000 ether);

        _finalize(0);

        (bool stamped, uint256 floor_, uint256 recycled, , ) =
            _agg().getDayPoolStamp(0);
        assertTrue(stamped, "day 0 still stamps (as zeros)");
        assertEq(floor_, 0, "day 0 schedule is zero");
        assertEq(recycled, 0, "coupled term gated off with the schedule");
    }

    function testMarginRetuneNeverRewritesStampedDay() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(5);
        (, , uint256 recycledBefore, , uint256 marginBefore) =
            _agg().getDayPoolStamp(5);
        assertEq(marginBefore, 500, "stamped at the default margin");

        // Retune to 25% — day 5 must keep its stamp; day 6 uses the new one.
        _cfg().setRecycleMarginBps(2_500);
        (, , uint256 recycledAfter, , uint256 marginAfter) =
            _agg().getDayPoolStamp(5);
        assertEq(marginAfter, 500, "stamp immutable after retune");
        assertEq(recycledAfter, recycledBefore, "recycled half unchanged");

        _mut().setRecycledCreditedByDayRaw(6, 700 ether);
        _finalize(6);
        (, , , , uint256 margin6) = _agg().getDayPoolStamp(6);
        assertEq(margin6, 2_500, "next day stamps the retuned margin");
    }

    function testFreshAvailableExhaustionZeroesFloorLeavingRecycledTerm() public {
        // Exhaust the 69M fresh pool → floor 0; the recycled term remains:
        // the promised steady state.
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);

        _finalize(5);

        (, uint256 floor_, uint256 recycled, , ) = _agg().getDayPoolStamp(5);
        assertEq(floor_, 0, "floor zero at fresh exhaustion");
        assertEq(recycled, 95 ether, "recycled term carries the pool alone");
    }

    // ─── Commitment arming (PR-3c cutover gate) ──────────────────────────────

    function testArmedStampReservesOutstandingCommitments() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _finalize(5);

        (, uint256 floor5, uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        (uint256 armed, uint256 outF, uint256 outR, ) =
            _agg().getGovernorCommitState();
        assertEq(armed, 5, "armed from day 5");
        assertEq(outF, floor5, "fresh commitment reserved");
        assertEq(outR, recycled5, "recycled commitment reserved");

        // The NEXT day's availability nets the day-5 reservations out:
        // fundable[6] = bucket − outR ⇒ with a tiny remaining bucket the
        // recycled term clamps to it.
        _mut().setRecycleBucketRaw(outR + 10 ether);
        _mut().setRecycledCreditedByDayRaw(6, 7_000 ether); // Ā big
        _finalize(6);
        (, , uint256 recycled6, , ) = _agg().getDayPoolStamp(6);
        assertEq(
            recycled6,
            10 ether,
            "fundable nets out prior armed commitments"
        );
    }

    function testPreArmingDaysNeverReserve() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(7); // arms in the future

        _finalize(5);

        (, uint256 outF, uint256 outR2, ) = _agg().getGovernorCommitState();
        // (destructure order: armedFromDay, fresh, recycled)
        assertEq(outF, 0, "pre-arming day reserves nothing (fresh)");
        assertEq(outR2, 0, "pre-arming day reserves nothing (recycled)");
    }
}
