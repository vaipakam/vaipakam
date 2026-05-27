// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../../src/facets/StakingRewardsFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";

/// @title SetupRewards — SetupCore + the 6 reward / VPFI facets.
/// @notice Adds the VPFI token surface + the four reward sub-systems on top
///         of Core. Target tests: `VPFIDiscountFacetTest`,
///         `StakingRewardsTest`, `InteractionRewardsTest`,
///         `CrossChainRewardPlumbingTest`.
///
/// @dev Compile cost: 14 facet TYPE imports vs the old `SetupTest`'s 39.
abstract contract SetupRewards is SetupCore {
    VPFITokenFacet internal vpfiTokenFacet;
    VPFIDiscountFacet internal vpfiDiscountFacet;
    StakingRewardsFacet internal stakingRewardsFacet;
    InteractionRewardsFacet internal interactionRewardsFacet;
    RewardAggregatorFacet internal rewardAggregatorFacet;
    RewardReporterFacet internal rewardReporterFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupCore → TestBase

        vpfiTokenFacet = new VPFITokenFacet();
        vpfiDiscountFacet = new VPFIDiscountFacet();
        stakingRewardsFacet = new StakingRewardsFacet();
        interactionRewardsFacet = new InteractionRewardsFacet();
        rewardAggregatorFacet = new RewardAggregatorFacet();
        rewardReporterFacet = new RewardReporterFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](6);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiTokenFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFITokenFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiDiscountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(stakingRewardsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getStakingRewardsFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(interactionRewardsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(rewardAggregatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardAggregatorFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(rewardReporterFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardReporterFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
