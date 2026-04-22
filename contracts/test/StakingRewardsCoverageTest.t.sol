// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../src/facets/StakingRewardsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title StakingRewardsCoverageTest
/// @notice Complements StakingAndInteractionRewardsTest with coverage for
///         the Synthetix-style accrual invariants and pool-cap semantics
///         (docs/TokenomicsTechSpec.md §7):
///           - multi-user time-weighted proportional accrual
///           - pull-only: accrual continues without auto-claim on top-ups
///           - pool-cap truncation at claim (paid = remaining)
///           - pool-exhausted revert (StakingPoolExhausted)
///           - totalStakedVPFI tracks deposit/withdraw exactly
///           - dormant-period freeze (no-stakers-means-no-RPT-growth)
contract StakingRewardsCoverageTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    VPFIDiscountFacet internal discountFacet;
    StakingRewardsFacet internal stakingFacet;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    address internal alice;
    address internal bob;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        discountFacet = new VPFIDiscountFacet();
        stakingFacet = new StakingRewardsFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(discountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(stakingFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getStakingRewardsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        alice = makeAddr("alice");
        bob = makeAddr("bob");

        // Fund wallets for deposits.
        vpfi.mint(alice, 100_000 ether);
        vpfi.mint(bob, 100_000 ether);
    }

    function _staking() internal view returns (StakingRewardsFacet) {
        return StakingRewardsFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _deposit(address user, uint256 amt) internal {
        vm.startPrank(user);
        vpfi.approve(address(diamond), amt);
        VPFIDiscountFacet(address(diamond)).depositVPFIToEscrow(amt);
        vm.stopPrank();
    }

    // ─── Accrual math ────────────────────────────────────────────────────────

    function testMultiUserProportionalAccrual() public {
        // Alice deposits 10k, Bob deposits 30k at t=0. After 180 days the
        // per-token rate is identical across the two, so each user's
        // pending is stake * accrued-rate. Bob should have exactly 3×
        // alice's pending (no rounding here because rpt is 1e18-scaled).
        _deposit(alice, 10_000 ether);
        _deposit(bob, 30_000 ether);

        vm.warp(block.timestamp + 180 days);

        uint256 pendingA = _staking().previewStakingRewards(alice);
        uint256 pendingB = _staking().previewStakingRewards(bob);

        assertEq(pendingB, pendingA * 3, "Bob at 3x Alice's stake earns 3x the reward");
    }

    function testMidPeriodDepositEarnsOnlyFromDepositTime() public {
        // Alice deposits at t=T0. Bob deposits at t=T0+180d. At t=T0+360d,
        // Alice earned a full year on 10k while Bob earned 6 months on 10k
        // - Alice's pending should be ~2x Bob's. Targets captured up-front
        // to avoid any IR-codegen reliance on t0's liveness past the first
        // warp.
        uint256 t0 = block.timestamp;
        uint256 warp1 = t0 + 180 days;
        uint256 warp2 = t0 + 360 days;

        _deposit(alice, 10_000 ether);

        vm.warp(warp1);
        _deposit(bob, 10_000 ether);

        vm.warp(warp2);

        uint256 pendingA = _staking().previewStakingRewards(alice);
        uint256 pendingB = _staking().previewStakingRewards(bob);
        assertGt(pendingB, 0, "bob must accrue after joining");
        assertApproxEqRel(pendingA, pendingB * 2, 1e14, "alice ~= 2x bob");
    }

    function testPullOnlyDepositDoesNotForceClaim() public {
        // After accrual, a follow-up deposit must NOT auto-transfer the
        // pending reward to the user's wallet. The pending should be
        // folded into the userPending counter instead, and the wallet
        // balance should only change by the deposit delta.
        _deposit(alice, 10_000 ether);
        vm.warp(block.timestamp + 30 days);

        uint256 pendingBefore = _staking().previewStakingRewards(alice);
        assertGt(pendingBefore, 0, "accrual sanity");

        uint256 walletBefore = vpfi.balanceOf(alice);
        _deposit(alice, 1_000 ether);

        // Wallet decreased by the deposit only — NO auto-claim happened.
        assertEq(vpfi.balanceOf(alice), walletBefore - 1_000 ether, "no auto-push");
        // Pending is preserved within 1 wei (deposit path runs updateUser
        // which folds the old-balance accrual into userPending).
        uint256 pendingAfter = _staking().previewStakingRewards(alice);
        assertApproxEqAbs(pendingAfter, pendingBefore, 1, "pending preserved");
    }

    // ─── Pool-cap enforcement ────────────────────────────────────────────────

    function testClaimTruncatedByRemainingStakingPool() public {
        _deposit(alice, 10_000 ether);
        vm.warp(block.timestamp + 365 days);

        uint256 pending = _staking().previewStakingRewards(alice);
        assertGt(pending, 1 ether, "need > 1 wei of pending for truncation test");

        // Leave exactly 1 VPFI in the pool.
        uint256 cap = LibVaipakam.VPFI_STAKING_POOL_CAP;
        _mut().setStakingPoolPaidOut(cap - 1 ether);

        uint256 walletBefore = vpfi.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = _staking().claimStakingRewards();

        assertEq(paid, 1 ether, "truncated to remaining");
        assertEq(vpfi.balanceOf(alice), walletBefore + 1 ether, "transfer matches");
        assertEq(_staking().getStakingPoolPaidOut(), cap, "paidOut == cap");
        assertEq(_staking().getStakingPoolRemaining(), 0, "pool exhausted");
    }

    function testClaimRevertsWhenStakingPoolExhausted() public {
        _deposit(alice, 10_000 ether);
        vm.warp(block.timestamp + 180 days);

        _mut().setStakingPoolPaidOut(LibVaipakam.VPFI_STAKING_POOL_CAP);

        vm.prank(alice);
        vm.expectRevert(StakingPoolExhausted.selector);
        _staking().claimStakingRewards();
    }

    // ─── totalStaked bookkeeping ─────────────────────────────────────────────

    function testTotalStakedTracksDepositsAndWithdrawals() public {
        _deposit(alice, 10_000 ether);
        assertEq(_staking().getTotalStakedVPFI(), 10_000 ether);

        _deposit(bob, 7_000 ether);
        assertEq(_staking().getTotalStakedVPFI(), 17_000 ether);

        vm.prank(alice);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromEscrow(4_000 ether);
        assertEq(_staking().getTotalStakedVPFI(), 13_000 ether);

        assertEq(_staking().getUserStakedVPFI(alice), 6_000 ether);
        assertEq(_staking().getUserStakedVPFI(bob), 7_000 ether);
    }

    // ─── Dormant-period semantics ────────────────────────────────────────────

    function testRewardPerTokenFrozenWhileTotalStakedZero() public {
        // With no stakers, time must NOT credit retroactive yield to the
        // first depositor. Warp 30 days before anyone deposits, then
        // deposit and warp 30 more — pending should reflect only the 30
        // days POST-deposit.
        vm.warp(block.timestamp + 30 days);
        _deposit(alice, 10_000 ether);

        // Compare to a reference deposit made at the same post-warp
        // timestamp: run a parallel path with bob, warp 30 days, both
        // should have the same pending.
        _deposit(bob, 10_000 ether);
        vm.warp(block.timestamp + 30 days);

        uint256 pendingA = _staking().previewStakingRewards(alice);
        uint256 pendingB = _staking().previewStakingRewards(bob);
        // Both joined at the same t, held same balance for same dt.
        assertEq(pendingA, pendingB, "no retroactive yield");
    }
}
