// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RecycleRegisterTest
 * @notice RL-4 (#1306, ratified §10.3) — the recycled-stream allocation
 *         register. Pins the ratified rules: dormant defaults are a no-op
 *         (exactly today's behaviour); a non-dormant split is bounded by
 *         BOTH the day's realized margin and the forward-reserve floor
 *         (`fundable − 7×Ā`); the keeper share moves bucket → keeper
 *         ledger with no token movement; the keeper weight caps at 50%.
 */
contract RecycleRegisterTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

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
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        vm.warp(block.timestamp + 6 days);
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

    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 20e18, 10e18);
        _agg().finalizeDay(dayId);
    }

    function testDormantDefaultIsANoOp() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(5);
        (uint16 bps, uint256 keeperBudget) = _cfg().getRecycleRegisterState();
        assertEq(bps, 0, "dormant by default");
        assertEq(keeperBudget, 0, "no keeper carve while dormant");
        assertEq(
            _cfg().getRecycleBucket(),
            1_000_000 ether,
            "bucket untouched"
        );
    }

    function testSplitBoundedByMarginAndForwardReserve() public {
        // Ā = 100; margin 5% ⇒ marginRealized = 5.
        // fundable ≈ 1M − recycled-commit; forward reserve = 700.
        // splittable = min(5, fundable − 700) = 5; keeper 40% ⇒ 2.
        _cfg().setRecycleRegisterKeeperBps(4_000);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(5);

        (, uint256 keeperBudget) = _cfg().getRecycleRegisterState();
        assertApproxEqAbs(keeperBudget, 2 ether, 1e6, "keeper = 40% of margin");
        assertApproxEqAbs(
            _cfg().getRecycleBucket(),
            1_000_000 ether - keeperBudget,
            1e6,
            "keeper share left the bucket ledger (reserve share stayed)"
        );
    }

    function testForwardReserveFloorsTheSplit() public {
        // Tiny bucket: fundable ≈ 705 < reserve 700 + margin ⇒ aboveReserve
        // ≈ 5-ish minus commitments; with bucket 700 exactly, aboveReserve
        // = 0 after the recycled commitment ⇒ no split despite margin > 0.
        _cfg().setRecycleRegisterKeeperBps(4_000);
        _mut().setRecycleBucketRaw(700 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(5);
        (, uint256 keeperBudget) = _cfg().getRecycleRegisterState();
        assertEq(keeperBudget, 0, "forward reserve floors the split to zero");
        // A quiet day with a large bucket and small commitments cannot
        // drain below RESERVE_N x A-bar — the ratified no-defund rule.
    }

    function testKeeperWeightCapsAtHalf() public {
        vm.expectRevert();
        _cfg().setRecycleRegisterKeeperBps(5_001);
        _cfg().setRecycleRegisterKeeperBps(5_000);
        (uint16 bps, ) = _cfg().getRecycleRegisterState();
        assertEq(bps, 5_000);
    }
}
