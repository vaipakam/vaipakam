// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardClaimBackingSeparationTest
 * @notice #1460 — the bucket/fresh separation invariant asserted across a
 *         PAYING claim.
 *
 *         The gap this closes: `recycleBucket` and the fresh reward budget
 *         are two protocol-owned claims on ONE fungible Diamond balance, and
 *         the claim path debited the bucket by the RECYCLED component only
 *         while transferring the AGGREGATE out — with no check that the
 *         FRESH part fitted in `balanceOf - recycleBucket`. The invariant was
 *         stated in the governor design (§7 #3), enforced on INFLOW by
 *         {LibVpfiRecycle.credit} and on the RL-3 EXPIRY sweep, claimed (over-
 *         claimed) in a {RewardAggregatorFacet} comment — and asserted by
 *         exactly one test, {RecycleBucketTest}, on a FORFEIT claim where
 *         `paid == 0`. A zero-payout claim cannot violate a separation
 *         invariant, so that assertion was vacuous for this defect: nothing
 *         anywhere exercised a claim that actually MOVED tokens.
 *
 *         Every test here therefore pays out, and each asserts the post-state
 *         `balanceOf(diamond) >= recycleBucket` that the defect broke.
 */
contract RewardClaimBackingSeparationTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    address internal alice;

    /// Mirrors {RewardClaimFacet.InteractionClaimFreshTruncated}.
    event InteractionClaimFreshTruncated(
        address indexed user,
        uint256 requestedFresh,
        uint256 cappedTo,
        uint256 backingRoom
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

        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        alice = makeAddr("alice");

        _facet().setInteractionLaunchTimestamp(block.timestamp);
        // Days 1 + 2 finalized in the past.
        vm.warp(block.timestamp + 5 days);

        // Alice is the only contributor on days 1–2; per-day cap disabled so
        // the accrual is the raw half-pool share (same scaffolding as
        // {RecycleBucketTest}, so the two suites agree on the fixture).
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed a CLOSED, NOT-forfeited lender entry over days 1–2 — i.e. a
    ///      claim that actually pays the claimant, which is the case the
    ///      pre-#1460 suite never exercised against the bucket.
    function _seedPayable(address user, uint64 loanId)
        internal
        returns (uint256 id, uint256 expected)
    {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, 100e18, 1
        );
        _mut().closeRewardEntryRaw(id, 3); // endDay = 3 ⇒ accrues days 1 + 2
        expected =
            _lens().getInteractionHalfPoolForDay(1) +
            _lens().getInteractionHalfPoolForDay(2);
    }

    // ─── The regression ──────────────────────────────────────────────────────

    /// The defect, direct: a fresh-only payout larger than the un-earmarked
    /// balance. Pre-#1460 it paid in full and left `recycleBucket` claiming
    /// more tokens than remained behind it.
    function testPayingClaimIsTruncatedToBackingRoomAndKeepsSeparation()
        public
    {
        (, uint256 expected) = _seedPayable(alice, 42);

        uint256 bal = vpfi.balanceOf(address(diamond));
        // Leave strictly between zero and the accrual, so the backing cap
        // binds while a partial payout is still possible.
        uint256 room = expected / 4;
        _mut().setRecycleBucketRaw(bal - room);

        // Topics-only: the accrual carries the entry formula's integer
        // rounding, so the amounts are asserted against state below.
        vm.expectEmit(true, false, false, false, address(diamond));
        emit InteractionClaimFreshTruncated(alice, expected, room, room);

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // Exact, not approximate: with no forfeit component the pro-rata
        // scaling degenerates to the cap itself.
        assertEq(paid, room, "payout truncated to the un-earmarked balance");
        assertLt(paid, expected, "the cap actually bound this claim");

        // THE assertion the pre-#1460 suite never made: separation across a
        // claim that moved tokens.
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation: bucket still fully backed after a PAYING claim"
        );
        assertEq(
            _cfg().getRecycleBucket(),
            bal - room,
            "a fresh-only claim neither debits nor credits the bucket"
        );
        assertEq(
            vpfi.balanceOf(alice),
            room,
            "claimant received exactly the backed amount"
        );
    }

    /// Zero un-earmarked balance is a FUNDING state, not an exhausted pool —
    /// and the two must be distinguishable, because the operator response
    /// differs (wait for the remit vs. the 69M schedule is spent). Reverting
    /// rather than paying zero is deliberate: a zero-payout claim would still
    /// consume the entry and retire its commitment.
    function testZeroBackingRevertsAsBackingShortNotPoolExhausted() public {
        _seedPayable(alice, 43);

        // Bucket claims the entire balance ⇒ backingRoom == 0, while the 69M
        // schedule still has essentially all of its headroom.
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));

        // Partial match on the SELECTOR: the error carries the exact accrual
        // (`freshSpend`), which is the entry formula's integer result and not
        // reproducible from the lens half-pools without re-deriving its
        // rounding. The selector is the property under test — that this is
        // reported as a backing shortfall and NOT as {InteractionPoolExhausted}.
        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation preserved by refusing the claim"
        );
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid out");
    }

    /// PROBE (#1460 adversarial self-review) — is a backing-truncated
    /// remainder recoverable once funding arrives?
    ///
    /// This is the question that decides truncate-vs-revert for the BACKING
    /// cap. The 69M pool cap may truncate freely because `remaining` is
    /// monotone non-increasing, so the trimmed remainder is unfundable
    /// forever and nothing is lost by consuming the entry. `backingRoom` is
    /// NOT monotone — it rises the moment a remit lands — so if the claim
    /// legs have already consumed the entitlement, truncating against
    /// backing would destroy value that was about to become payable.
    function testTruncatedRemainderRecoverabilityAfterFunding() public {
        (, uint256 expected) = _seedPayable(alice, 45);
        uint256 bal = vpfi.balanceOf(address(diamond));
        uint256 room = expected / 4;
        _mut().setRecycleBucketRaw(bal - room);

        vm.prank(alice);
        (uint256 firstPaid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(firstPaid, room, "first claim truncated to backing");

        // Funding arrives: the bucket's claim on the balance shrinks, so the
        // un-earmarked room now comfortably covers the trimmed remainder.
        _mut().setRecycleBucketRaw(1 ether);

        vm.prank(alice);
        try RewardClaimFacet(address(diamond)).claimInteractionRewards()
        returns (uint256 secondPaid, uint256, uint256) {
            emit log_named_uint("remainder recovered on retry", secondPaid);
            assertGt(
                secondPaid,
                0,
                "RECOVERABLE: truncation is safe for a non-monotone cap"
            );
        } catch {
            emit log("retry REVERTED - entitlement was consumed by the first claim");
            fail();
        }
    }

    /// Negative control — the cap must not over-truncate. With ample
    /// un-earmarked balance the same claim pays in full and emits no
    /// truncation event.
    function testAmpleBackingPaysInFullAndDoesNotTruncate() public {
        (, uint256 expected) = _seedPayable(alice, 44);
        _mut().setRecycleBucketRaw(1 ether); // negligible against the seed

        vm.recordLogs();
        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertApproxEqAbs(
            paid, expected, 1e6, "full accrual paid when backing is ample"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 truncSig = keccak256(
            "InteractionClaimFreshTruncated(address,uint256,uint256,uint256)"
        );
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != truncSig,
                "no truncation event when nothing was truncated"
            );
        }
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation holds on the untruncated path too"
        );
    }
}
