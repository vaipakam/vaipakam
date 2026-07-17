// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardClaimHorizonTest
 * @notice RL-3 (#1305, ratified §10.2) — the 365-day post-claimability
 *         claim horizon. Pins the ratified rules:
 *
 *           1. DARK by default: with the knob unset nothing stamps and
 *              nothing ever expires.
 *           2. Two-phase sweep: first touch of a claimable entry STAMPS
 *              the clock (no expiry); a second touch inside the horizon is
 *              a no-op; past `stamp + H` the entry expires into the
 *              recycle bucket as `ExpiredReward` absorption (fresh share
 *              consumes the pool cap + feeds `credited[D]`).
 *           3. A claim before expiry always wins — and an expired entry
 *              pays a late claimant nothing (processed, like any claim).
 *           4. The clock never starts while claimability is blocked on
 *              finalization.
 *           5. Knob bounds `[180, 1095]`, 0 = dark reset.
 */
contract RewardClaimHorizonTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    address internal alice;

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

        alice = makeAddr("alice");
        _facet().setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 3 days);

        // Day 1 finalized + uncapped so an entry over [1,2) is claimable.
        _mut().setKnownGlobalDailyInterest(1, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Claimable lender entry over day 1 sweeping the whole side.
    function _seedClaimableEntry() internal returns (uint256 id) {
        id = _mut().pushRewardEntry(
            alice, 42, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(id, 2);
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function testDarkByDefaultNothingStampsOrExpires() public {
        uint256 id = _seedClaimableEntry();
        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);
        (uint64 stamp, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "dark: no clock");
        assertEq(expiry, 0, "dark: no expiry");
        // A year later, still nothing.
        vm.warp(block.timestamp + 400 days);
        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);
        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );
        assertGt(paid, 0, "reward untouched while dark");
    }

    function testStampThenExpireIntoBucketAsAbsorption() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();

        // Touch 1: stamps, expires nothing.
        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);
        (uint64 stamp, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "clock started");
        assertEq(expiry, stamp + 365 days, "expiry = stamp + H");

        // Touch 2 inside the horizon: no-op.
        vm.warp(block.timestamp + 364 days);
        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);

        // Past the horizon: expires; fresh share consumes the pool and
        // credits the bucket as ExpiredReward absorption.
        vm.warp(block.timestamp + 2 days);
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 poolBefore = _facet().getInteractionPoolPaidOut();
        uint256 swept = _facet().sweepExpiredInteractionRewards(_ids(id));
        assertGt(swept, 0, "expired value swept");
        assertEq(
            _cfg().getRecycleBucket() - bucketBefore,
            swept,
            "bucket credited (all-fresh entry)"
        );
        assertEq(
            _facet().getInteractionPoolPaidOut() - poolBefore,
            swept,
            "fresh pool consumed by the expiry"
        );

        // 3. The late claimant gets nothing (processed, like a claim).
        vm.prank(alice);
        vm.expectRevert(); // NoInteractionRewardsToClaim (nothing pending)
        _facet().claimInteractionRewards();
    }

    function testClaimBeforeExpiryAlwaysWins() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp

        vm.warp(block.timestamp + 300 days); // inside the horizon
        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );
        assertGt(paid, 0, "claim wins inside the horizon");

        vm.warp(block.timestamp + 100 days); // past would-be expiry
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "claimed entry can never expire"
        );
    }

    function testClockFrozenWhileClaimabilityBlocked() public {
        _cfg().setRewardClaimHorizonDays(365);
        // Entry over day 2 — NOT finalized, so the claim is blocked.
        uint256 id = _mut().pushRewardEntry(
            alice, 43, LibVaipakam.RewardSide.Lender, 1e18, 2
        );
        _mut().closeRewardEntryRaw(id, 3);

        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);
        (uint64 stamp, ) = _facet().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "clock never starts while blocked");

        // Finalize day 2 → the next touch starts the clock.
        _mut().setKnownGlobalDailyInterest(2, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(2, type(uint256).max);
        vm.warp(block.timestamp + 1 days);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (stamp, ) = _facet().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "clock starts once claimable");
    }

    function testHorizonKnobBounds() public {
        vm.expectRevert();
        _cfg().setRewardClaimHorizonDays(179);
        vm.expectRevert();
        _cfg().setRewardClaimHorizonDays(1096);
        _cfg().setRewardClaimHorizonDays(180);
        assertEq(_cfg().getRewardClaimHorizonDays(), 180);
        _cfg().setRewardClaimHorizonDays(0); // dark reset allowed
        assertEq(_cfg().getRewardClaimHorizonDays(), 0);
    }
}
