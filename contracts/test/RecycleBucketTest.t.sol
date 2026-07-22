// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RecycleBucketTest
 * @notice Governor PR-3a (#1217 / #1222 §5) — the recycle-bucket ledger
 *         foundation. Proves the load-bearing properties:
 *
 *           1. A claim-path forfeit stays in DIAMOND custody (no treasury
 *              transfer, no balance movement) and credits the bucket +
 *              the day-bucketed `credited[D]` feed, emitting
 *              {LibVpfiRecycle.VpfiRecycled}.
 *           2. The permissionless per-loan sweep routes identically, with
 *              `refId = loanId`.
 *           3. Pool accounting is unchanged: forfeits still consume the
 *              69M cap (`interactionPoolPaidOut`) exactly as before — only
 *              the destination ledger changed (treasury → bucket).
 *           4. The bucket is a pure ledger slice: crediting never moves
 *              tokens, so `diamondBalance ≥ recycleBucket` holds trivially
 *              and the governor §5 separation invariant is preserved at
 *              this chokepoint by construction.
 */
contract RecycleBucketTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    address internal alice;
    address internal treasuryRecipient;

    event VpfiRecycled(
        uint8 indexed source,
        uint256 indexed refId,
        uint256 amount,
        uint256 dayId
    );

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

        // External treasury so "no treasury transfer" is observable.
        treasuryRecipient = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        alice = makeAddr("alice");

        _facet().setInteractionLaunchTimestamp(block.timestamp);
        // Days 1 + 2 finalized in the past.
        vm.warp(block.timestamp + 5 days);

        // Entry-path scaffolding: alice is the only contributor on days
        // 1–2; per-day cap disabled so amounts are the raw pool shares.
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    ///  #1306 follow-up — read-only lens accessor (getters moved off
    ///      InteractionRewardsFacet into InteractionRewardsLensFacet).
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed a FORFEITED, closed lender entry for `user` over days 1–2
    ///      (endDay 3 exclusive) and return (entryId, expected accrual).
    function _seedForfeited(address user, uint64 loanId)
        internal
        returns (uint256 id, uint256 expected)
    {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, 100e18, 1
        );
        _mut().closeRewardEntryRaw(id, 3);
        _mut().setRewardEntryForfeitedRaw(id);
        expected =
            _lens().getInteractionHalfPoolForDay(1) +
            _lens().getInteractionHalfPoolForDay(2);
    }

    // ─── Claim-path forfeit → bucket ─────────────────────────────────────────

    function testClaimPathForfeitCreditsBucketNotTreasury() public {
        (, uint256 expected) = _seedForfeited(alice, 42);

        uint256 diamondBalBefore = vpfi.balanceOf(address(diamond));
        (uint256 today, ) = _lens().getInteractionCurrentDay();

        // Topics-only check (source, refId): the exact accrual carries the
        // entry-path formula's integer rounding, asserted against state below.
        vm.expectEmit(true, true, false, false, address(diamond));
        emit VpfiRecycled(
            uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward),
            0,
            expected,
            today
        );

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(paid, 0, "forfeited entry pays the claimant nothing");
        uint256 bucket = _cfg().getRecycleBucket();
        assertApproxEqAbs(
            bucket, expected, 1e6, "bucket credited the forfeited accrual"
        );
        assertEq(
            _cfg().getRecycledCreditedByDay(today),
            bucket,
            "day-bucketed credited[D] recorded on the claim day"
        );
        assertEq(
            vpfi.balanceOf(treasuryRecipient),
            0,
            "treasury receives NOTHING (recycle, not treasury routing)"
        );
        assertEq(
            vpfi.balanceOf(address(diamond)),
            diamondBalBefore,
            "ledger re-label only, no token movement"
        );
        // Pool accounting unchanged: the forfeit consumed the 69M cap.
        assertEq(
            _lens().getInteractionPoolPaidOut(),
            bucket,
            "forfeit still consumes the interaction pool"
        );
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation: bucket is a slice of the diamond balance"
        );
    }

    // ─── Permissionless sweep → bucket ───────────────────────────────────────

    function testSweepForfeitCreditsBucketWithLoanRef() public {
        uint64 loanId = 77;
        (uint256 id, uint256 expected) = _seedForfeited(alice, loanId);
        _mut().setLoanActiveLenderEntryId(loanId, id);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        // Topics-only (source, refId=loanId); exact amount asserted vs state.
        vm.expectEmit(true, true, false, false, address(diamond));
        emit VpfiRecycled(
            uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward),
            loanId,
            expected,
            today
        );

        // Permissionless: a random keeper sweeps.
        vm.prank(makeAddr("keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(loanId);

        assertApproxEqAbs(swept, expected, 1e6, "sweep ~= forfeited accrual");
        assertEq(_cfg().getRecycleBucket(), swept, "bucket credited == swept");
        assertEq(
            _cfg().getRecycledCreditedByDay(today),
            swept,
            "credited[D] matches the sweep"
        );
        assertEq(vpfi.balanceOf(treasuryRecipient), 0, "treasury untouched");
    }

    // ─── Backing check (Codex #1312 P1) ──────────────────────────────────────

    /// @notice An UNDERFUNDED Diamond must not mint unbacked recycle credits:
    ///         the credit chokepoint reverts, rolling back the whole sweep
    ///         (processed flags + pool accounting included) — the same
    ///         revert-on-underfunded behaviour the pre-PR-3a treasury
    ///         transfer provided, strictly stronger.
    function testUnderfundedDiamondRevertsInsteadOfUnbackedCredit() public {
        uint64 loanId = 78;
        (uint256 id, ) = _seedForfeited(alice, loanId);
        _mut().setLoanActiveLenderEntryId(loanId, id);

        // Drain the Diamond's VPFI (test-only burn via the token owner).
        uint256 bal = vpfi.balanceOf(address(diamond));
        vm.prank(address(diamond));
        vpfi.transfer(address(this), bal);

        vm.prank(makeAddr("keeper"));
        vm.expectRevert(); // InsufficientRecycleBacking(needed, 0)
        _facet().sweepForfeitedInteractionRewards(loanId);

        // Whole frame rolled back: nothing processed, nothing credited.
        assertEq(_cfg().getRecycleBucket(), 0, "no unbacked credit");
        assertEq(
            _lens().getInteractionPoolPaidOut(),
            0,
            "pool accounting rolled back with the revert"
        );

        // Refund the Diamond → the same sweep now succeeds.
        vpfi.transfer(address(diamond), bal);
        vm.prank(makeAddr("keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(loanId);
        assertGt(swept, 0, "sweep succeeds once backed");
        assertEq(_cfg().getRecycleBucket(), swept, "credit backed and recorded");
    }

    // ─── Clean claims unaffected ─────────────────────────────────────────────

    function testCleanClaimPaysUserAndLeavesBucketEmpty() public {
        uint256 id = _mut().pushRewardEntry(
            alice, 43, LibVaipakam.RewardSide.Lender, 100e18, 1
        );
        _mut().closeRewardEntryRaw(id, 3);
        // NOT forfeited — a proper close.

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );

        assertGt(paid, 0, "clean entry pays the user");
        assertEq(_cfg().getRecycleBucket(), 0, "no credit on a clean claim");
        assertEq(vpfi.balanceOf(alice), paid, "user received the reward");
    }
}
