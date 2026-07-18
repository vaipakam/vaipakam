// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardClaimHorizonTest
 * @notice RL-3 (#1305, ratified §10.2; Codex #1317 r7 heartbeat redesign) —
 *         the post-claimability claim horizon. Expiry is driven by
 *         EXECUTABLE-ELAPSED time: an entry can only be reaped once keepers
 *         have observed it claim-executable, with no gap over the max
 *         observation bound, for a full `H + notice` of accrued time. Pins:
 *
 *           1. DARK by default: with the knob unset nothing stamps/accrues.
 *           2. First executable touch STAMPS + starts the accumulator; the
 *              entry expires only once `execElapsed ≥ H + notice`, then it
 *              lands in the recycle bucket as `ExpiredReward` absorption.
 *           3. A claim before expiry always wins.
 *           4. The accumulator never advances while claimability is blocked
 *              on finalization, funding, or sanctions.
 *           5. An UNOBSERVED gap over the bound is never credited (the core
 *              soundness property: blocked time cannot consume the window).
 *           6. A horizon reconfiguration re-earns a fresh executable notice.
 *           7. Knob bounds `[180, 1095]`, 0 = dark reset.
 */
contract RewardClaimHorizonTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    address internal alice;

    // Mirror of the contract constants for readable arithmetic.
    uint256 internal constant NOTICE = 90 days;
    uint256 internal constant MAX_GAP = 7 days;

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

    /// @dev Accrue `duration` of CONTINUOUSLY-executable time by heartbeat
    ///      sweeping every ≤ MAX_GAP (so each interval is credited). Stops
    ///      early and returns >0 the moment the entry expires. Assumes the
    ///      entry is already stamped (call sweep once first).
    function _accrue(uint256 id, uint256 duration)
        internal
        returns (uint256 swept)
    {
        uint256 remaining = duration;
        while (remaining > 0) {
            uint256 step = remaining < MAX_GAP ? remaining : MAX_GAP;
            vm.warp(vm.getBlockTimestamp() + step);
            uint256 s = _facet().sweepExpiredInteractionRewards(_ids(id));
            swept += s;
            remaining -= step;
            if (s > 0) break; // expired — stop warping
        }
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
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        uint256 required = 180 days + NOTICE;

        // Touch 1: stamps, accrues nothing yet.
        assertEq(_facet().sweepExpiredInteractionRewards(_ids(id)), 0);
        (uint64 stamp, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "clock started");
        // Countdown = now + the full required executable time (nothing accrued).
        assertEq(
            expiry,
            uint64(vm.getBlockTimestamp() + required),
            "countdown = now + H + notice when nothing accrued"
        );

        // Accrue to just under the threshold — not expirable yet.
        assertEq(_accrue(id, required - MAX_GAP), 0, "not yet H + notice");
        (, expiry) = _facet().getRewardEntryExpiry(id);
        assertEq(
            expiry,
            uint64(vm.getBlockTimestamp() + MAX_GAP),
            "countdown shrinks as executable time accrues"
        );

        // The final interval crosses H + notice → expires into the bucket.
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 poolBefore = _facet().getInteractionPoolPaidOut();
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        uint256 swept = _facet().sweepExpiredInteractionRewards(_ids(id));
        assertGt(swept, 0, "expires at H + notice of executable time");
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

        // The late claimant gets nothing (processed, like a claim).
        vm.prank(alice);
        vm.expectRevert();
        _facet().claimInteractionRewards();
    }

    function testClaimBeforeExpiryAlwaysWins() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 120 days); // partway through the horizon

        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );
        assertGt(paid, 0, "claim wins before expiry");

        // Even a full further window can never expire a claimed entry.
        assertEq(
            _accrue(id, 180 days + NOTICE),
            0,
            "claimed entry can never expire"
        );
    }

    function testClockFrozenWhileClaimabilityBlocked() public {
        _cfg().setRewardClaimHorizonDays(180);
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

    /// @notice CORE SOUNDNESS: an unobserved gap longer than the max
    ///         observation bound is never credited toward the window, so a
    ///         funding/keeper outage cannot let the clock run past time the
    ///         claimant could not actually claim.
    function testUnobservedGapIsNotCreditedAsExecutableTime() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + 60 days); // horizon + 60 of the 90 notice days

        // A long UNOBSERVED interval passes with no keeper touch.
        vm.warp(vm.getBlockTimestamp() + 200 days);
        // A single executable sweep after: the 200-day gap > MAX_GAP is NOT
        // credited, so the entry is NOT expirable despite 200 wall-clock days.
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "unobserved gap over the bound is not credited; no premature expiry"
        );
        // It still needs the remaining 30 executable days of the notice.
        assertEq(_accrue(id, 30 days - MAX_GAP), 0, "still short of the window");
        assertGt(
            _accrue(id, 2 * MAX_GAP),
            0,
            "expires only after the FULL executable window is genuinely served"
        );
    }

    /// @notice A boundary gap (== MAX_GAP) is credited; a gap one step over
    ///         it is dropped — pinning the exact crediting rule.
    function testMaxObservationGapBoundary() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        // Accrue the whole horizon, then all but MAX_GAP of the notice.
        _accrue(id, 180 days + NOTICE - MAX_GAP);

        // A gap just OVER the bound does not credit → still not expirable.
        vm.warp(vm.getBlockTimestamp() + MAX_GAP + 1);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "gap over the bound is dropped"
        );
        // A gap exactly AT the bound credits → crosses the threshold, expires.
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        assertGt(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "gap at the bound is credited and completes the window"
        );
    }

    function testUnfundedTimeNeverAccrues() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();

        // Remittance outage: the chain cannot pay the claim → no stamp.
        deal(address(vpfi), address(diamond), 0);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (uint64 stamp, ) = _facet().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "no clock while the chain cannot pay");

        // Funding arrives → the accumulator starts here.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        _accrue(id, 180 days + 60 days); // horizon + 60 notice days

        // Mid-notice outage: touches during it credit nothing; recovery does
        // not spring expiry — the notice must be genuinely funded throughout.
        deal(address(vpfi), address(diamond), 0);
        assertEq(_accrue(id, 60 days), 0, "unfunded touches never accrue");
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "recovery alone never expires"
        );
        assertGt(
            _accrue(id, 30 days + MAX_GAP),
            0,
            "expires only after the remaining funded notice is served"
        );
    }

    function testSanctionedOwnerNeverAccrues() public {
        _cfg().setRewardClaimHorizonDays(180);
        MockSanctionsList oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        uint256 id = _seedClaimableEntry();

        // Flagged owner: the claim path rejects them → clock never starts.
        oracle.setFlagged(alice, true);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (uint64 stamp, ) = _facet().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "no clock while the owner is sanctioned");

        // Delisted: the accumulator starts and accrues.
        oracle.setFlagged(alice, false);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        _accrue(id, 180 days + 60 days);

        // Re-flagged mid-notice: sanctioned touches credit nothing.
        oracle.setFlagged(alice, true);
        assertEq(_accrue(id, 60 days), 0, "sanctioned touches never accrue");
        // Delist and serve the remaining funded notice → expires.
        oracle.setFlagged(alice, false);
        assertGt(
            _accrue(id, 30 days + MAX_GAP),
            0,
            "expires only after a genuinely claimable window"
        );
    }

    function testReconfigurationReEarnsExecutableNotice() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        // Accrue 300 executable days — inside the 365-day horizon phase.
        _accrue(id, 300 days);

        // Governance shortens the horizon to 180: the 300 accrued days now
        // exceed the new horizon, so the accrual is CAPPED back to 180 and
        // the full notice must be re-earned under the new configuration.
        _cfg().setRewardClaimHorizonDays(180);
        assertEq(
            _accrue(id, NOTICE - MAX_GAP),
            0,
            "shortening caps to the new horizon; notice must be re-earned"
        );
        assertGt(
            _accrue(id, 2 * MAX_GAP),
            0,
            "expires only after the re-earned funded notice is served"
        );
    }

    function testDarkResetReEarnsNotice() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        // Accrue the ENTIRE window — the entry is at the brink of expiry.
        _accrue(id, 180 days + NOTICE - MAX_GAP);

        // Dark reset then re-enable BEFORE the last step: the accrual is
        // capped to the horizon, so a fresh full notice must be re-earned —
        // a dormant claimant is never reaped without a fresh funded notice.
        _cfg().setRewardClaimHorizonDays(0);
        _cfg().setRewardClaimHorizonDays(180);
        assertEq(
            _accrue(id, NOTICE - MAX_GAP),
            0,
            "dark reset re-earns the full notice"
        );
        assertGt(
            _accrue(id, 2 * MAX_GAP),
            0,
            "expires after the re-earned funded notice"
        );
    }

    /// @notice A SHORT outage the keeper actually observes (< max gap) must
    ///         still not be credited — the observed-block flag drops the
    ///         interval spanning it (Codex #1317 r8 P1).
    function testObservedShortOutageIsNotCredited() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + 50 days); // elapsed ≈ 230, needs 40 more

        // Short observed outage: keeper sees non-executable, then recovery
        // within the max-gap bound (total 6 days < 7).
        vm.warp(vm.getBlockTimestamp() + 3 days);
        deal(address(vpfi), address(diamond), 0);
        _facet().sweepExpiredInteractionRewards(_ids(id)); // observed block
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        _facet().sweepExpiredInteractionRewards(_ids(id)); // recovery re-baseline

        // The FULL 40 executable days are still required: 37 is not enough
        // (would be, at 34, had the 6-day observed outage been credited).
        assertEq(_accrue(id, 37 days), 0, "observed outage was not credited");
        assertGt(
            _accrue(id, 2 * MAX_GAP),
            0,
            "expires only after the genuine executable window"
        );
    }

    /// @notice The countdown view must credit the pending heartbeat gap a
    ///         sweep-now would apply, so it never reports a removal LATER
    ///         than the contract enforces (Codex #1317 r8 P2).
    function testCountdownIncludesPendingHeartbeatGap() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + NOTICE - MAX_GAP); // elapsed ≈ required − 7

        // Exactly a max-gap later: a sweep now would credit the pending 7
        // days and remove the entry, so the view must report expiry at NOW.
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        (, uint64 expiry) = _facet().getRewardEntryExpiry(id);
        assertEq(
            expiry,
            uint64(vm.getBlockTimestamp()),
            "view credits the pending heartbeat gap"
        );
        assertGt(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "and a sweep indeed removes it now"
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
