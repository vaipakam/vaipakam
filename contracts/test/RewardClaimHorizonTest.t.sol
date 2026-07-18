// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
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

    /// @dev #1306 follow-up — read-only countdown view moved to the lens.
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
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
        (uint64 stamp, uint64 expiry) = _lens().getRewardEntryExpiry(id);
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
        (uint64 stamp, uint64 expiry) = _lens().getRewardEntryExpiry(id);
        assertGt(stamp, 0, "clock started");
        // Countdown = now + the full required executable time (nothing accrued).
        assertEq(
            expiry,
            uint64(vm.getBlockTimestamp() + required),
            "countdown = now + H + notice when nothing accrued"
        );

        // Accrue to just under the threshold — not expirable yet.
        assertEq(_accrue(id, required - MAX_GAP), 0, "not yet H + notice");
        (, expiry) = _lens().getRewardEntryExpiry(id);
        assertEq(
            expiry,
            uint64(vm.getBlockTimestamp() + MAX_GAP),
            "countdown shrinks as executable time accrues"
        );

        // The final interval crosses H + notice → expires into the bucket.
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 poolBefore = _lens().getInteractionPoolPaidOut();
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        uint256 swept = _facet().sweepExpiredInteractionRewards(_ids(id));
        assertGt(swept, 0, "expires at H + notice of executable time");
        assertEq(
            _cfg().getRecycleBucket() - bucketBefore,
            swept,
            "bucket credited (all-fresh entry)"
        );
        assertEq(
            _lens().getInteractionPoolPaidOut() - poolBefore,
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
        (uint64 stamp, ) = _lens().getRewardEntryExpiry(id);
        assertEq(stamp, 0, "clock never starts while blocked");

        // Finalize day 2 → the next touch starts the clock.
        _mut().setKnownGlobalDailyInterest(2, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(2, type(uint256).max);
        vm.warp(block.timestamp + 1 days);
        _facet().sweepExpiredInteractionRewards(_ids(id));
        (stamp, ) = _lens().getRewardEntryExpiry(id);
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
        (uint64 stamp, ) = _lens().getRewardEntryExpiry(id);
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
        (uint64 stamp, ) = _lens().getRewardEntryExpiry(id);
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
        (, uint64 expiry) = _lens().getRewardEntryExpiry(id);
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

    /// @notice Two shortenings in the SAME block, with a reconcile sweep
    ///         between, must each re-earn a fresh notice — the epoch is
    ///         strictly monotonic so the second retune is distinguishable
    ///         even at an unchanged block timestamp (Codex #1317 r9).
    function testSameBlockDoubleRetuneReEarnsNotice() public {
        _cfg().setRewardClaimHorizonDays(365);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 300 days); // elapsed ≈ 300, inside the 365 horizon

        // retune1 → reconcile (caps 300→250) → retune2, all same block.
        _cfg().setRewardClaimHorizonDays(250);
        _facet().sweepExpiredInteractionRewards(_ids(id)); // reconcile to 250
        _cfg().setRewardClaimHorizonDays(180);

        // Under a non-monotonic epoch the second retune would be a no-op and
        // the entry (elapsed 250) would expire after only ~20 more days
        // against the 270 threshold. Monotonic ⇒ it re-caps to 180 and the
        // full 90-day notice is required afresh.
        assertEq(
            _accrue(id, 30 days),
            0,
            "same-block retune2 re-earns the full notice, not ~20 days"
        );
        assertGt(
            _accrue(id, NOTICE),
            0,
            "expires only after the re-earned 90-day notice"
        );
    }

    /// @notice The expiry credit grows the recycle bucket, so it is capped
    ///         to the bucket's backing room — a batch can never revert on
    ///         {LibVpfiRecycle.credit}'s backing assertion (Codex #1317 r9).
    function testExpiryNeverRevertsOnBucketBacking() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + NOTICE - MAX_GAP); // to just under threshold

        // Label the ENTIRE Diamond balance as bucket ⇒ zero backing room for
        // a fresh credit. The final crossing must NOT revert the batch; the
        // all-fresh entry simply defers (its fresh share is uncreditable).
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "no revert at zero backing - deferred, not reverted"
        );

        // Restore backing ⇒ the entry expires on the next funded window.
        _mut().setRecycleBucketRaw(0);
        assertGt(
            _accrue(id, 3 * MAX_GAP),
            0,
            "expires once the bucket backing is restored"
        );
    }

    /// @notice The countdown view must pause (not fold in the pending gap)
    ///         while the entry is currently non-executable, so it never
    ///         shows a false imminent removal a sweep-now can't perform
    ///         (Codex #1317 r11).
    function testCountdownPausesWhileBlocked() public {
        _cfg().setRewardClaimHorizonDays(180);
        MockSanctionsList oracle = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + NOTICE - MAX_GAP); // to just under threshold

        // A max-gap passes and the owner is sanctioned, with NO keeper touch —
        // so the observed-block flag stays clear and only the VIEW can catch
        // it.
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        oracle.setFlagged(alice, true);
        // The view must NOT fold the pending gap (a sweep-now credits nothing
        // for a sanctioned owner), so it reports remaining time, not `now`.
        (, uint64 blockedExpiry) = _lens().getRewardEntryExpiry(id);
        assertGt(
            blockedExpiry,
            uint64(vm.getBlockTimestamp()),
            "countdown paused while sanctioned, not imminent"
        );

        // Once delisted (still no intervening keeper touch), the view folds
        // the pending gap and reports NOW.
        oracle.setFlagged(alice, false);
        (, uint64 fundedExpiry) = _lens().getRewardEntryExpiry(id);
        assertEq(
            fundedExpiry,
            uint64(vm.getBlockTimestamp()),
            "countdown resumes and reports now once delisted"
        );
    }

    /// @notice A claimed (processed) entry carries no expiry countdown
    ///         (Codex #1317 r11).
    function testProcessedEntryHasNoCountdown() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 60 days);

        (, uint64 liveExpiry) = _lens().getRewardEntryExpiry(id);
        assertGt(liveExpiry, 0, "live entry has a countdown");

        vm.prank(alice);
        _facet().claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        (, uint64 processedExpiry) = _lens().getRewardEntryExpiry(id);
        assertEq(processedExpiry, 0, "claimed entry shows no countdown");
    }

    /// @notice The countdown must also pause when the sweep would DEFER for a
    ///         zero-creditable fresh share (69M pool cap exhausted / no
    ///         recycle-bucket backing room), not just for a sanction — the
    ///         view mirrors the sweep's payability + defer exactly
    ///         (Codex #1317 XuF).
    function testCountdownPausesAtPoolExhaustion() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry(); // all-fresh entry
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        _accrue(id, 180 days + NOTICE - MAX_GAP); // to just under threshold

        // Exhaust the 69M fresh pool with NO keeper touch (so only the VIEW
        // can catch it): a sweep-now would defer (zero-credit fresh), so the
        // view must NOT fold the pending gap — it reports remaining time,
        // not `now`. (The sweep-side defer itself is pinned by the governor
        // suite's testExpirySweepDefersAtFullFreshExhaustion.)
        vm.warp(vm.getBlockTimestamp() + MAX_GAP);
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        (, uint64 blockedExpiry) = _lens().getRewardEntryExpiry(id);
        assertGt(
            blockedExpiry,
            uint64(vm.getBlockTimestamp()),
            "countdown paused at pool exhaustion, not imminent"
        );

        // Restore pool headroom (still no keeper touch) → the view folds the
        // pending gap and reports now.
        _mut().setInteractionPoolPaidOut(0);
        (, uint64 fundedExpiry) = _lens().getRewardEntryExpiry(id);
        assertEq(
            fundedExpiry,
            uint64(vm.getBlockTimestamp()),
            "countdown resumes once the pool has headroom"
        );
    }

    /// @notice The accrual gate mirrors the CLAIM transfer (fresh capped to
    ///         the pool, plus recycled), not a backing-capped sliver — so an
    ///         entry whose FULL claim would revert for insufficient balance
    ///         never accrues, even if a smaller capped amount is covered
    ///         (Codex #1317). No partial-funded reap.
    function testAccrualPausesWhenFullClaimExceedsBalance() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp
        (uint256 fullClaim, , ) = _lens().previewInteractionRewards(alice);
        assertGt(fullClaim, 1, "entry has a claimable amount");

        // Balance one wei below the full claim. A large bucket would have made
        // the OLD backing-capped payable tiny (< balance) and wrongly kept the
        // clock running; the fixed gate pauses because a real claim reverts.
        deal(address(vpfi), address(diamond), fullClaim - 1);
        _mut().setRecycleBucketRaw((fullClaim - 1) / 2);

        // A full window of heartbeats must never expire it while unaffordable.
        assertEq(
            _accrue(id, 180 days + NOTICE + MAX_GAP),
            0,
            "no accrual/expiry while the full claim exceeds balance"
        );

        // Fund the full claim → it accrues and expires normally.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        _mut().setRecycleBucketRaw(0);
        assertGt(
            _accrue(id, 180 days + NOTICE + MAX_GAP),
            0,
            "accrues + expires once the full claim is affordable"
        );
    }

    /// @notice The claim is ATOMIC-AGGREGATE across all of a user's claimable
    ///         entries — so the clock advances only when the balance covers the
    ///         user's FULL claim, never a single entry. A balance that covers
    ///         each entry alone but not the aggregate must start NEITHER clock
    ///         (the real claim reverts), or a keeper could reap an entry the
    ///         claimant never had a funded path to claim (Codex #1317 P1).
    function testAggregateClaimUnderfundingPausesAllEntries() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Two claimable entries for the same user, paid atomically by a claim.
        uint256 idA = _mut().pushRewardEntry(
            alice, 42, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(idA, 2);
        uint256 idB = _mut().pushRewardEntry(
            alice, 43, LibVaipakam.RewardSide.Borrower, 1e18, 1
        );
        _mut().closeRewardEntryRaw(idB, 2);

        // Stamp both (funded) — this also advances the per-side cursors the
        // preview reads, so the aggregate resolves to its true non-zero value.
        uint256[] memory both = new uint256[](2);
        both[0] = idA;
        both[1] = idB;
        _facet().sweepExpiredInteractionRewards(both);
        (uint256 aggregate, , ) = _lens().previewInteractionRewards(alice);
        assertGt(aggregate, 1, "user has an aggregate claim");

        // Balance covers each single entry (each < aggregate) but NOT the
        // atomic aggregate — a per-entry funding check would keep the clock
        // ticking; the aggregate gate must PAUSE accrual for the entry.
        deal(address(vpfi), address(diamond), aggregate - 1);
        assertEq(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A never accrues while the aggregate claim is underfunded"
        );

        // Restore full funding → the clock resumes and the entry expires.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        assertGt(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A expires once the full aggregate claim is affordable"
        );
    }

    /// @notice The aggregate funding gate must account for the user's OTHER
    ///         finalized entries even when a keeper has only swept one — their
    ///         cumulative cursor reads behind until advanced, so a naive
    ///         view-only preview understates the claim. The sweep advances
    ///         every one of the user's side cursors before the funding check,
    ///         so a large unswept entry still keeps the swept entry's clock
    ///         paused while its claim would revert (Codex #1317 r2 xkk).
    function testUnadvancedEntryCountsInAggregateFundingGate() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Finalize days 1..5 so a later entry is claimable but cursor-behind.
        for (uint32 d = 2; d <= 5; d++) {
            _mut().setKnownGlobalDailyInterest(d, 1e18, 1e18, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
        }
        vm.warp(block.timestamp + 10 days); // today past day 5

        // A: small, over day 1. B: 1000x larger, over day 5 — finalized but its
        // cursor stays behind until something advances the lender cursor to 5.
        uint256 idA = _mut().pushRewardEntry(
            alice, 42, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(idA, 2);
        uint256 idB = _mut().pushRewardEntry(
            alice, 43, LibVaipakam.RewardSide.Lender, 1000e18, 5
        );
        _mut().closeRewardEntryRaw(idB, 6);

        // Before any sweep both cursors are behind, so the preview sees
        // nothing — neither entry's value is resolvable yet.
        (uint256 pre, , ) = _lens().previewInteractionRewards(alice);
        assertEq(pre, 0, "cursors behind: preview is 0 pre-sweep");

        // Stamp ONLY idA. The gate advances EVERY one of alice's side cursors
        // (not just the swept entry's), so idB — which no keeper has swept —
        // is now resolvable and counted (the xkk fix). The aggregate jumps to
        // include B's ~1000x value.
        _facet().sweepExpiredInteractionRewards(_ids(idA));
        (uint256 aggFull, , ) = _lens().previewInteractionRewards(alice);
        assertGt(aggFull, pre + 1000e18, "unswept idB is now counted");

        // Balance one wei under the full aggregate — a gate that ignored the
        // unswept idB would see only A and let the clock run; the fixed gate
        // pauses because the real atomic claim (A + B) would revert.
        deal(address(vpfi), address(diamond), aggFull - 1);
        assertEq(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A never accrues while the unswept entry B is underfunded"
        );

        // Fund the full aggregate → A accrues and expires.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        assertGt(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A expires once A + B is affordable"
        );
    }

    /// @notice The claim also processes the user's FORFEITED entries, whose
    ///         treasury credit reverts unless the post-payout balance backs
    ///         `recycleBucket + forfeitFresh`. The gate folds that in, so a
    ///         payable entry's clock pauses while a co-owned forfeited entry
    ///         would make the atomic claim revert (Codex #1317 r2 xkq).
    function testForfeitedEntryBackingCountsInFundingGate() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 idA = _seedClaimableEntry();               // payable
        uint256 idF = _mut().pushRewardEntry(
            alice, 43, LibVaipakam.RewardSide.Borrower, 1e18, 1
        );
        _mut().closeRewardEntryRaw(idF, 2);
        _mut().setRewardEntryForfeitedRaw(idF);            // forfeited → treasury

        // Stamp A (funded) + advance cursors so the preview is exact.
        uint256[] memory both = new uint256[](2);
        both[0] = idA;
        both[1] = idF;
        _facet().sweepExpiredInteractionRewards(both);
        (uint256 payout, , ) = _lens().previewInteractionRewards(alice);
        assertGt(payout, 0, "A previews non-zero");

        // Bucket ledger set high; balance covers the payout AND the bucket but
        // leaves NO headroom for the forfeit's fresh treasury credit — so the
        // atomic claim would revert and A's clock must pause.
        uint256 bucket = 5_000 ether;
        _mut().setRecycleBucketRaw(bucket);
        deal(address(vpfi), address(diamond), payout + bucket);
        assertEq(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A never accrues while the forfeit credit is unbacked"
        );

        // Full funding → the forfeit credit fits, the claim is executable, A
        // accrues and expires.
        deal(address(vpfi), address(diamond), DIAMOND_SEED);
        assertGt(
            _accrue(idA, 180 days + NOTICE + MAX_GAP),
            0,
            "A expires once the forfeit-inclusive claim is affordable"
        );
    }

    /// @notice Time during which the protocol is paused is NOT executable
    ///         (every claim reverts under the pause), so an observation
    ///         interval that straddles a pause window — even one shorter than
    ///         the max observation gap — must not be credited toward the
    ///         horizon (Codex #1317 P2). The sweep is `whenNotPaused`, so it
    ///         can only discover the slept-through span after unpause.
    function testPausedIntervalIsNotCreditedAsExecutableTime() public {
        _cfg().setRewardClaimHorizonDays(180);
        uint256 required = 180 days + NOTICE;
        uint256 id = _seedClaimableEntry();
        _facet().sweepExpiredInteractionRewards(_ids(id)); // stamp

        // Accrue to five days under the threshold.
        assertEq(_accrue(id, required - 5 days), 0, "just under threshold");

        // A 5-day pause (< MAX_GAP). Keepers can't sweep while paused.
        AdminFacet(address(diamond)).pause();
        vm.warp(vm.getBlockTimestamp() + 5 days);
        AdminFacet(address(diamond)).unpause();

        // Keeper resumes a little after unpause (its observation timestamp is
        // strictly past the pause boundary — the realistic cadence). The first
        // post-unpause sweep sees a gap that straddled the pause boundary, so
        // it must be DROPPED: the entry is not reaped even though the pause's
        // wall time elapsed.
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(
            _facet().sweepExpiredInteractionRewards(_ids(id)),
            0,
            "the paused span is not credited as executable time"
        );

        // A further genuinely-executable 5 days is still required to expire.
        assertEq(_accrue(id, 4 days), 0, "still one day short after the pause");
        assertGt(
            _accrue(id, 2 days),
            0,
            "expires once a real 5 days elapses post-pause"
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
