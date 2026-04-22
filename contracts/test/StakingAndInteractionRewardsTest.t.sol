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
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title StakingAndInteractionRewardsTest
/// @notice Smoke tests for the Phase-1 VPFI reward surfaces — staking (5% APR
///         on escrow-held VPFI) and interaction (daily USD-share emissions).
///         See docs/TokenomicsTechSpec.md §4 and §7.
contract StakingAndInteractionRewardsTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfiToken;
    VPFIDiscountFacet internal discountFacet;
    StakingRewardsFacet internal stakingFacet;
    InteractionRewardsFacet internal interactionFacet;

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

        // ── Cut in VPFIDiscount + StakingRewards + InteractionRewards
        discountFacet = new VPFIDiscountFacet();
        stakingFacet = new StakingRewardsFacet();
        interactionFacet = new InteractionRewardsFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
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
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(interactionFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Fund users with VPFI + approve the discount facet for deposit.
        vpfiToken.transfer(lender, 20_000 ether);
        vpfiToken.transfer(borrower, 20_000 ether);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.startPrank(user);
        vpfiToken.approve(address(diamond), amount);
        VPFIDiscountFacet(address(diamond)).depositVPFIToEscrow(amount);
        vm.stopPrank();
    }

    function _staking() internal view returns (StakingRewardsFacet) {
        return StakingRewardsFacet(address(diamond));
    }

    function _interaction() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    // ─── Staking ─────────────────────────────────────────────────────────────

    function testStakingAccruesAtFivePercentAPR() public {
        _deposit(lender, 10_000 ether);
        assertEq(_staking().getUserStakedVPFI(lender), 10_000 ether);
        assertEq(_staking().getTotalStakedVPFI(), 10_000 ether);

        vm.warp(block.timestamp + 365 days);

        // expected ≈ 10_000 * 5% = 500 VPFI (within 1 wei of rounding)
        uint256 pending = _staking().previewStakingRewards(lender);
        uint256 expected = (10_000 ether * 500) / 10_000;
        assertApproxEqAbs(pending, expected, 1e12);
    }

    function testStakingClaimTransfersAndUpdatesPool() public {
        _deposit(lender, 10_000 ether);
        vm.warp(block.timestamp + 30 days);

        uint256 balBefore = vpfiToken.balanceOf(lender);
        vm.prank(lender);
        uint256 paid = _staking().claimStakingRewards();

        assertGt(paid, 0);
        assertEq(vpfiToken.balanceOf(lender), balBefore + paid);
        assertEq(_staking().getStakingPoolPaidOut(), paid);
        // pending should reset to ~0
        assertLt(_staking().previewStakingRewards(lender), 1e9);
    }

    function testStakingClaimRevertsWhenNothingPending() public {
        vm.prank(lender);
        vm.expectRevert(NoStakingRewardsToClaim.selector);
        _staking().claimStakingRewards();
    }

    function testWithdrawReducesStakeAndReturnsWallet() public {
        _deposit(lender, 5_000 ether);
        assertEq(_staking().getUserStakedVPFI(lender), 5_000 ether);

        uint256 walletBefore = vpfiToken.balanceOf(lender);
        vm.prank(lender);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromEscrow(2_000 ether);

        assertEq(_staking().getUserStakedVPFI(lender), 3_000 ether);
        assertEq(vpfiToken.balanceOf(lender), walletBefore + 2_000 ether);
    }

    function testWithdrawRevertsOnOverflow() public {
        _deposit(lender, 1_000 ether);
        vm.prank(lender);
        vm.expectRevert(VPFIEscrowBalanceInsufficient.selector);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromEscrow(2_000 ether);
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
