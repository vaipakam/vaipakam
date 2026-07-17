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

        // Past the horizon: the first funded touch ARMS the final-notice
        // window (nothing expires yet); processing needs a second touch
        // ≥ 90 days later.
        vm.warp(block.timestamp + 2 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "due touch only arms the funded final notice"
        );
        (, uint64 armedExpiry) = _facet().getRewardEntryExpiry(id);
        assertEq(
            armedExpiry,
            uint64(block.timestamp + 90 days),
            "view reflects the armed final-notice window"
        );
        vm.warp(block.timestamp + 91 days);
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

    function testDarkResetRegrantsNoticeFloor() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp

        // Dark reset mid-horizon; a long dark interval passes, far beyond
        // the stale stamp's `stamp + H`.
        vm.warp(block.timestamp + 200 days);
        _cfg().setRewardClaimHorizonDays(0);
        vm.warp(block.timestamp + 400 days);

        // Re-activation re-grants the ratified ≥90-day notice floor: the
        // stale-stamped entry cannot be expired immediately.
        _cfg().setRewardClaimHorizonDays(365);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "notice floor blocks immediate expiry after re-activation"
        );
        (, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertEq(
            expiry,
            uint64(block.timestamp + 90 days),
            "expiry lifted to activation + notice"
        );

        vm.warp(block.timestamp + 89 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "still inside the notice window"
        );
        vm.warp(block.timestamp + 2 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "past the floor: arms the funded final notice"
        );
        vm.warp(block.timestamp + 91 days);
        assertGt(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "expires once the armed notice elapses"
        );
    }

    function testShorteningHorizonRegrantsNoticeFloor() public {
        _cfg().setRewardClaimHorizonDays(1095);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp

        // Past the SHORT horizon but well inside the configured long one.
        vm.warp(block.timestamp + 200 days);
        _cfg().setRewardClaimHorizonDays(180);

        // The retune re-stamps the notice floor — the next sweep cannot
        // spring instant expiry on the already-stamped dormant entry.
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "a shortened horizon cannot spring expiry"
        );
        (, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertEq(
            expiry,
            uint64(block.timestamp + 90 days),
            "expiry lifted to retune + notice"
        );
        // Distinct absolute warp targets: two identical
        // `block.timestamp + N` warp expressions can be CSE'd by the
        // optimizer (TIMESTAMP is tx-constant in real EVM semantics),
        // making the second warp a no-op.
        uint256 tArm = block.timestamp + 91 days;
        vm.warp(tArm);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "past the floor: arms the funded final notice"
        );
        vm.warp(tArm + 91 days);
        assertGt(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "expires once the armed notice elapses"
        );
    }

    function testUnderfundedChainNeverStampsOrExpires() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();

        // Remittance outage: the chain cannot pay the entry's claim, so
        // horizon time must not count — no stamp.
        deal(address(vpfi), address(diamond), 0);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (uint64 stamp, ) = _facet().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "no clock while the chain cannot pay");

        // Funding arrives → the clock starts from here, not earlier.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (stamp, ) = _facet().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "clock starts once funded");

        // An outage AT the expiry moment blocks even the ARMING touch.
        vm.warp(block.timestamp + 366 days);
        deal(address(vpfi), address(diamond), 0);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "outage blocks arming too"
        );
        (, uint64 preArmExpiry) = _facet().getRewardEntryExpiry(id);

        // Funding returns: the funded touch arms the final notice, and
        // only after it elapses does the entry expire — the outage never
        // consumed the claimant's executable window.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "funded touch arms, never expires instantly post-outage"
        );
        (, uint64 postArmExpiry) = _facet().getRewardEntryExpiry(id);
        assertGt(
            postArmExpiry,
            preArmExpiry,
            "armed notice extends past the outage"
        );
        vm.warp(block.timestamp + 91 days);
        assertGt(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "expires after a fully funded final notice"
        );
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
