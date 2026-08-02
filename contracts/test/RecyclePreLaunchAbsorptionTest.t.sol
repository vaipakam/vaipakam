// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from
    "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RecyclePreLaunchAbsorptionTest
 * @notice #1504 — absorption credited while the emission schedule is
 *         INACTIVE belongs to no programme day.
 *
 *         It used to land in `recycledCreditedByDay[0]`, which made day 0
 *         the sum of an arbitrarily long pre-launch period AND the first
 *         scheduled day, inseparably. Two consequences, and the tests below
 *         pin both:
 *
 *           1. the published per-day series showed a day-0 bucket that can
 *              dwarf every real day;
 *           2. `Ā` — a trailing MEAN DAILY rate — folded that stock in for
 *              a full window at programme start, sizing the earliest
 *              coupled recycled budgets off value no single day produced.
 *
 *         What must NOT change: the tokens are in the bucket either way, so
 *         `recycleBucket`, the recycled cumulative, and therefore every
 *         backing and availability figure are identical. Only attribution
 *         moves. Several tests below assert exactly that, because a fix
 *         that quietly dropped value would be far worse than the defect.
 */
contract RecyclePreLaunchAbsorptionTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);
        // The launch timestamp is deliberately left UNSET: each test decides
        // whether the schedule is running, because that is the branch under
        // test.
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _launchNow() internal {
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
    }

    function _credit(uint256 refId, uint256 amount) internal {
        _mut().creditRecycleRaw(
            LibVpfiRecycle.RecycleSource.ForfeitedReward, refId, amount
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Attribution
    // ─────────────────────────────────────────────────────────────────

    function testPreLaunchCreditStaysOutOfTheDaySeries() public {
        _credit(1, 5_000 ether);

        assertEq(
            _lens().getRecycledCreditedPreLaunch(),
            5_000 ether,
            "pre-launch credit must land in its own slot"
        );
        assertEq(
            ConfigFacet(address(diamond)).getRecycledCreditedByDay(0),
            0,
            "day 0 must not absorb a pre-launch credit"
        );
    }

    function testDayZeroHoldsOnlyTheFirstScheduledDay() public {
        // A long pre-launch period, then the schedule starts and a genuine
        // day-0 credit lands. Day 0 must report the second figure alone.
        _credit(1, 40_000 ether);
        _launchNow();
        _credit(2, 700 ether);

        assertEq(
            ConfigFacet(address(diamond)).getRecycledCreditedByDay(0),
            700 ether,
            "day 0 must be the first SCHEDULED day and nothing else"
        );
        assertEq(
            _lens().getRecycledCreditedPreLaunch(),
            40_000 ether,
            "the pre-launch stock stays readable, just not as a day"
        );
    }

    function testPreLaunchCreditsAccumulateAcrossManyCredits() public {
        _credit(1, 100 ether);
        _credit(2, 250 ether);
        _credit(3, 1 ether);
        assertEq(_lens().getRecycledCreditedPreLaunch(), 351 ether);
    }

    // ─────────────────────────────────────────────────────────────────
    // Value is NOT lost — only its attribution moves
    // ─────────────────────────────────────────────────────────────────

    function testBucketAndCumulativeCountPreLaunchCreditsIdentically() public {
        uint256 bucketBefore = _mut().getRecycleBucketRaw();

        _credit(1, 9_000 ether);

        assertEq(
            _mut().getRecycleBucketRaw(),
            bucketBefore + 9_000 ether,
            "the bucket must grow by a pre-launch credit exactly as before"
        );
        assertEq(
            ConfigFacet(address(diamond)).getRecycleCreditedCumulative(),
            9_000 ether,
            "the recycled cumulative must count it; availability depends on it"
        );
    }

    function testBackingIsUnchangedByTheAttributionMove() public {
        _credit(1, 3_000 ether);
        (uint256 balance, uint256 bucket,,,,) =
            _lens().getRecycleBackingSnapshot();
        assertEq(balance, DIAMOND_SEED, "no tokens moved");
        assertEq(bucket, 3_000 ether, "the bucket is earmarked as before");
    }

    // ─────────────────────────────────────────────────────────────────
    // Events — the failure mode of each shape is the reason for this one
    // ─────────────────────────────────────────────────────────────────

    function testPreLaunchCreditAnnouncesItselfAsPreLaunch() public {
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibVpfiRecycle.VpfiRecycledPreLaunch(
            uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 7, 12 ether
        );
        _credit(7, 12 ether);
    }

    function testScheduledCreditStillAnnouncesItselfWithItsDay() public {
        _launchNow();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibVpfiRecycle.VpfiRecycled(
            uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 8, 4 ether, 0
        );
        _credit(8, 4 ether);
    }

    /**
     * A consumer that only knows the old event must see NOTHING for a
     * pre-launch credit, not a day-0 credit.
     *
     * This is the whole reason a separate event was chosen over a widened
     * one or a sentinel day: an unread flag is absent, and absent reads as
     * `false`/`0`, which puts the value straight back into day 0 — the
     * defect being fixed. Omission understates; mis-bucketing inflates.
     */
    function testTheOldEventIsNotEmittedForAPreLaunchCredit() public {
        vm.recordLogs();
        _credit(9, 1 ether);

        bytes32 oldTopic = keccak256("VpfiRecycled(uint8,uint256,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != oldTopic,
                "a pre-launch credit must not masquerade as a day-0 credit"
            );
        }
    }
}
