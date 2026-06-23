// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title StakingAndInteractionRewardsTest
/// @notice Smoke tests for the Phase-1 VPFI reward surfaces — vault
///         deposit / withdraw and interaction (daily USD-share emissions).
///         See docs/TokenomicsTechSpec.md §4. (#687-B removed the 5% VPFI
///         staking-yield surface; the discount tiers + interaction rewards
///         remain.)
contract StakingAndInteractionRewardsTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfiToken;
    // #229: VPFIDiscount + StakingRewards + InteractionRewards facets
    // now cut by `SetupTest.setupHelper()`; prior local declarations +
    // local cut block dropped.

    uint256 internal constant DIAMOND_FUND = 200_000_000 ether; // 200M VPFI seed

    function setUp() public {
        setupHelper();

        // ── Deploy VPFI + register on the diamond
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));

        // Initial mint only seeds 23M. Mint extra so the test has enough
        // VPFI to fund the diamond (reward pools) + user wallets.
        uint256 needed = DIAMOND_FUND + 40_000 ether;
        uint256 have = vpfiToken.balanceOf(address(this));
        if (needed > have) {
            vpfiToken.mint(address(this), needed - have);
        }
        vpfiToken.transfer(address(diamond), DIAMOND_FUND);

        // #229 — VPFIDiscount, StakingRewards, and InteractionRewards
        // facets are now cut by setupHelper(); the prior 3-entry local
        // cut block here would double-cut all three and revert.

        // Fund users with VPFI + approve the discount facet for deposit.
        vpfiToken.transfer(lender, 20_000 ether);
        vpfiToken.transfer(borrower, 20_000 ether);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.startPrank(user);
        vpfiToken.approve(address(diamond), amount);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amount);
        vm.stopPrank();
    }

    function _interaction() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    // ─── Vault deposit / withdraw ──────────────────────────────────────────────
    // #687-B: the 5% staking-yield accrual/claim tests were removed with the
    // yield. The deposit/withdraw mechanics (which back the discount tiers) stay.

    function testWithdrawReturnsVPFIToWallet() public {
        _deposit(lender, 5_000 ether);

        uint256 walletBefore = vpfiToken.balanceOf(lender);
        vm.prank(lender);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(2_000 ether);

        assertEq(vpfiToken.balanceOf(lender), walletBefore + 2_000 ether);
    }

    function testWithdrawRevertsOnOverflow() public {
        _deposit(lender, 1_000 ether);
        vm.prank(lender);
        vm.expectRevert(VPFIVaultBalanceInsufficient.selector);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(2_000 ether);
    }

    // ─── Interaction ─────────────────────────────────────────────────────────

    function testInteractionLaunchTimestampOneShot() public {
        _interaction().setInteractionLaunchTimestamp(block.timestamp);
        vm.expectRevert(bytes("launch already set"));
        _interaction().setInteractionLaunchTimestamp(block.timestamp + 1);
    }

    function testInteractionClaimRevertsBeforeLaunch() public {
        vm.prank(lender);
        vm.expectRevert(InteractionEmissionsNotStarted.selector);
        _interaction().claimInteractionRewards();
    }

    function testInteractionScheduleBands() public {
        // Spot-check a few decay-band boundaries.
        assertEq(_interaction().getInteractionAnnualRateBps(0), 3200);
        assertEq(_interaction().getInteractionAnnualRateBps(182), 3200);
        assertEq(_interaction().getInteractionAnnualRateBps(183), 2900);
        assertEq(_interaction().getInteractionAnnualRateBps(547), 2900);
        assertEq(_interaction().getInteractionAnnualRateBps(548), 2400);
        assertEq(_interaction().getInteractionAnnualRateBps(2373), 500);
        assertEq(_interaction().getInteractionAnnualRateBps(10_000), 500);
    }

    function testInteractionHalfPoolMatchesFormula() public {
        // Day 0 of the global emissions window is excluded per
        // docs/TokenomicsTechSpec.md §4 so sub-24h-old loans don't compete
        // for the first day's emission.
        assertEq(_interaction().getInteractionHalfPoolForDay(0), 0);

        // halfPool_d = bps * 23M * 1e18 / (BPS * 365 * 2)
        // Day 1 is still in band 0 (bps=3200).
        uint256 bps = 3200;
        uint256 expected = (bps * 23_000_000 ether) / (10_000 * 365 * 2);
        assertEq(_interaction().getInteractionHalfPoolForDay(1), expected);
    }

    function testInteractionSnapshotReturnsCapAndLaunch() public {
        (uint256 cap, uint256 paidOut, uint256 remaining, uint256 launch, , ) =
            _interaction().getInteractionSnapshot();
        assertEq(cap, 69_000_000 ether);
        assertEq(paidOut, 0);
        assertEq(remaining, cap);
        assertEq(launch, 0);

        _interaction().setInteractionLaunchTimestamp(block.timestamp);
        (, , , uint256 launch2, uint256 today, uint256 aprBps) =
            _interaction().getInteractionSnapshot();
        assertEq(launch2, block.timestamp);
        assertEq(today, 0);
        assertEq(aprBps, 3200);
    }
}
