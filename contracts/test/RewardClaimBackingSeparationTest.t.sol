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

    /// The defect, direct — and the property that decides its remedy.
    ///
    /// A fresh-only payout larger than the un-earmarked balance. Pre-#1460
    /// it paid in FULL and left `recycleBucket` claiming more tokens than
    /// remained behind it. It must now be refused — and refusing rather than
    /// part-paying is the load-bearing choice: the claim legs commit before
    /// the caps run, so a part-payment would consume the entry and delete
    /// the untruncated remainder. This test pins BOTH halves: the refusal,
    /// and that the claimant is made whole once funding lands.
    function testUnderfundedClaimIsRefusedAndLosesNothing() public {
        (, uint256 expected) = _seedPayable(alice, 42);

        uint256 bal = vpfi.balanceOf(address(diamond));
        // Backing covers a QUARTER of the accrual: enough that a truncating
        // implementation would happily pay a partial claim here.
        uint256 room = expected / 4;
        _mut().setRecycleBucketRaw(bal - room);

        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(vpfi.balanceOf(alice), 0, "nothing paid while underfunded");
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation: bucket still fully backed"
        );

        // Funding arrives — the bucket's claim on the balance shrinks.
        _mut().setRecycleBucketRaw(1 ether);

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // THE no-value-loss property: the FULL accrual, not the quarter a
        // truncating implementation would have paid before consuming the
        // entry. "Recoverable back-pressure, never lost value"
        // (TokenomicsTechSpec section 4a).
        assertApproxEqAbs(
            paid, expected, 1e6, "claimant made whole once backing lands"
        );
        assertGt(paid, room * 3, "recovered far more than a part-payment");
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation holds across the PAYING claim too"
        );
    }

    /// Diagnosis accuracy. Zero backing and an exhausted 69M pool both stop
    /// a claim, and an operator's response to them differs completely — one
    /// resolves when funding lands, the other never does. Here the schedule
    /// has essentially all of its headroom and only the backing is gone, so
    /// the claim must report a backing shortfall and NOT
    /// {InteractionPoolExhausted}.
    function testZeroBackingReportsBackingShortNotPoolExhausted() public {
        _seedPayable(alice, 43);
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));

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

    /// Negative control — the gate must not over-refuse. With ample
    /// un-earmarked balance the same claim pays in full.
    function testAmpleBackingPaysInFull() public {
        (, uint256 expected) = _seedPayable(alice, 44);
        _mut().setRecycleBucketRaw(1 ether); // negligible against the seed

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertApproxEqAbs(
            paid, expected, 1e6, "full accrual paid when backing is ample"
        );
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation holds on the unblocked path too"
        );
    }
}
