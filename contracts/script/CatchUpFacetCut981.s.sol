// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "./DeployDiamond.s.sol";
import {Deployments} from "./lib/Deployments.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {DiamondLoupeFacet} from "../src/facets/DiamondLoupeFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MirrorTierReceiverFacet} from "../src/facets/MirrorTierReceiverFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {ReceiverFacet} from "../src/facets/ReceiverFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";

/**
 * @title CatchUpFacetCut981
 * @notice One-shot TESTNET catch-up cut: FULL facet refresh that brings
 *         an already-deployed Diamond (last refreshed by the #959
 *         catch-up) up to current `main`, which since added #981 — the
 *         sanctions close-out sweep + frozen-surplus escrow hardening
 *         (the implementation of the #986 design, Parts 1-2; Part 3
 *         shipped inside #959 and is already live).
 *
 *         WHY a FULL refresh instead of a minimal set: #981 changed
 *         shared internal libraries whose code INLINES into every facet
 *         that references it — `LibVPFIDiscount.rollupUserDiscount`
 *         (the wrapper every VPFI tier stamp funnels through) gained
 *         the frozen-owed exclusion in its body, and 22 facets import
 *         that library; LibVaipakam gained the borrowerSurplusClaims /
 *         frozenVpfiOwedByVault storage plumbing. Hand-picking the
 *         minimal facet set risks leaving one facet on the OLD inlined
 *         library (split-brain accounting). Redeploying every routed
 *         facet guarantees bytecode parity with a fresh DeployDiamond
 *         of current main — same Diamond address, storage untouched.
 *
 *         Selector lists are INHERITED from `DeployDiamond.s.sol`
 *         (CI-guarded by SelectorCoverageTest), split at runtime against
 *         the live loupe: routed selectors -> Replace, unrouted -> Add.
 *         Post-cut, every selector is loupe-verified and all facet
 *         addresses are persisted to `deployments/<slug>/addresses.json`.
 *
 * @dev   TESTNET ONLY. Env: DEPLOYER_PRIVATE_KEY (the Diamond owner).
 *
 *        Usage (from contracts/, on main):
 *          forge script script/CatchUpFacetCut981.s.sol \
 *            --sig "catchUp()" --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow
 *        then the same with $ARB_SEPOLIA_RPC_URL.
 *        Afterwards: bash script/exportFrontendDeployments.sh
 */
contract CatchUpFacetCut981 is DeployDiamond {
    struct Item {
        string key;
        address impl;
        bytes4[] selectors;
    }

    uint256 constant N = 63;

    function catchUp() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 421614 || cid == 97 || cid == 11155111 || cid == 11155420 || cid == 31337,
            "CatchUpFacetCut981: testnet only"
        );
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        IDiamondLoupe loupe = IDiamondLoupe(diamond);

        console.log("=== Catch-up facet cut (#981 sweep) - FULL refresh ===");
        console.log("Chain id:", cid);
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);

        Item[] memory items = new Item[](N);
        items[0] = Item("loupeFacet", address(new DiamondLoupeFacet()), _getLoupeSelectors());
        items[1] = Item("ownershipFacet", address(new OwnershipFacet()), _getOwnershipSelectors());
        items[2] = Item("accessControlFacet", address(new AccessControlFacet()), _getAccessControlSelectors());
        items[3] = Item("adminFacet", address(new AdminFacet()), _getAdminSelectors());
        items[4] = Item("profileFacet", address(new ProfileFacet()), _getProfileSelectors());
        items[5] = Item("oracleFacet", address(new OracleFacet()), _getOracleSelectors());
        items[6] = Item("oracleAdminFacet", address(new OracleAdminFacet()), _getOracleAdminSelectors());
        items[7] = Item("nftFacet", address(new VaipakamNFTFacet()), _getNftSelectors());
        items[8] = Item("vaultFactoryFacet", address(new VaultFactoryFacet()), _getVaultFactorySelectors());
        items[9] = Item("offerCreateFacet", address(new OfferCreateFacet()), _getOfferCreateSelectors());
        items[10] = Item("loanFacet", address(new LoanFacet()), _getLoanSelectors());
        items[11] = Item("repayFacet", address(new RepayFacet()), _getRepaySelectors());
        items[12] = Item("defaultedFacet", address(new DefaultedFacet()), _getDefaultedSelectors());
        items[13] = Item("riskFacet", address(new RiskFacet()), _getRiskSelectors());
        items[14] = Item("claimFacet", address(new ClaimFacet()), _getClaimSelectors());
        items[15] = Item("addCollateralFacet", address(new AddCollateralFacet()), _getAddCollateralSelectors());
        items[16] = Item("treasuryFacet", address(new TreasuryFacet()), _getTreasurySelectors());
        items[17] = Item("earlyWithdrawalFacet", address(new EarlyWithdrawalFacet()), _getEarlyWithdrawalSelectors());
        items[18] = Item("partialWithdrawalFacet", address(new PartialWithdrawalFacet()), _getPartialWithdrawalSelectors());
        items[19] = Item("precloseFacet", address(new PrecloseFacet()), _getPrecloseSelectors());
        items[20] = Item("refinanceFacet", address(new RefinanceFacet()), _getRefinanceSelectors());
        items[21] = Item("metricsFacet", address(new MetricsFacet()), _getMetricsSelectors());
        items[22] = Item("vpfiTokenFacet", address(new VPFITokenFacet()), _getVpfiTokenSelectors());
        items[23] = Item("vpfiDiscountFacet", address(new VPFIDiscountFacet()), _getVpfiDiscountSelectors());
        items[24] = Item("consolidationFacet", address(new ConsolidationFacet()), _getConsolidationFacetSelectors());
        items[25] = Item("interactionRewardsFacet", address(new InteractionRewardsFacet()), _getInteractionRewardsSelectors());
        items[26] = Item("rewardReporterFacet", address(new RewardReporterFacet()), _getRewardReporterSelectors());
        items[27] = Item("rewardAggregatorFacet", address(new RewardAggregatorFacet()), _getRewardAggregatorSelectors());
        items[28] = Item("configFacet", address(new ConfigFacet()), _getConfigSelectors());
        items[29] = Item("legalFacet", address(new LegalFacet()), _getLegalSelectors());
        items[30] = Item("offerMatchFacet", address(new OfferMatchFacet()), _getOfferMatchSelectors());
        items[31] = Item("offerCancelFacet", address(new OfferCancelFacet()), _getOfferCancelSelectors());
        items[32] = Item("metricsDashboardFacet", address(new MetricsDashboardFacet()), _getMetricsDashboardSelectors());
        items[33] = Item("payrollFacet", address(new PayrollFacet()), _getPayrollSelectors());
        items[34] = Item("riskMatchLiquidationFacet", address(new RiskMatchLiquidationFacet()), _getRiskMatchLiquidationSelectors());
        items[35] = Item("offerAcceptFacet", address(new OfferAcceptFacet()), _getOfferAcceptSelectors());
        items[36] = Item("offerMutateFacet", address(new OfferMutateFacet()), _getOfferMutateSelectors());
        items[37] = Item("prepayListingFacet", address(new PrepayListingFacet()), _getPrepayListingSelectors());
        items[38] = Item("nftPrepayListingFacet", address(new NFTPrepayListingFacet()), _getNFTPrepayListingSelectors());
        items[39] = Item("nftPrepayDutchListingFacet", address(new NFTPrepayDutchListingFacet()), _getNFTPrepayDutchListingSelectors());
        items[40] = Item("nftPrepayListingAtomicFacet", address(new NFTPrepayListingAtomicFacet()), _getNFTPrepayListingAtomicSelectors());
        items[41] = Item("nftPrepayAutoListFacet", address(new NFTPrepayAutoListFacet()), _getNFTPrepayAutoListSelectors());
        items[42] = Item("offerParallelSaleFacet", address(new OfferParallelSaleFacet()), _getOfferParallelSaleSelectors());
        items[43] = Item("swapToRepayFacet", address(new SwapToRepayFacet()), _getSwapToRepayFacetSelectors());
        items[44] = Item("swapToRepayIntentFacet", address(new SwapToRepayIntentFacet()), _getSwapToRepayIntentFacetSelectors());
        items[45] = Item("intentConfigFacet", address(new IntentConfigFacet()), _getIntentConfigSelectors());
        items[46] = Item("vpfiDiscountAccumulatorFacet", address(new VPFIDiscountAccumulatorFacet()), _getVpfiDiscountAccumulatorSelectors());
        items[47] = Item("mirrorTierReceiverFacet", address(new MirrorTierReceiverFacet()), _getMirrorTierReceiverSelectors());
        items[48] = Item("protocolBroadcastFacet", address(new ProtocolBroadcastFacet()), _getProtocolBroadcastSelectors());
        items[49] = Item("intentDispatchFacet", address(new IntentDispatchFacet()), _getIntentDispatchFacetSelectors());
        items[50] = Item("autoLifecycleFacet", address(new AutoLifecycleFacet()), _getAutoLifecycleFacetSelectors());
        items[51] = Item("encumbranceMutateFacet", address(new EncumbranceMutateFacet()), _getEncumbranceMutateFacetSelectors());
        items[52] = Item("repayPeriodicFacet", address(new RepayPeriodicFacet()), _getRepayPeriodicFacetSelectors());
        items[53] = Item("signedOfferFacet", address(new SignedOfferFacet()), _getSignedOfferFacetSelectors());
        items[54] = Item("lenderIntentFacet", address(new LenderIntentFacet()), _getLenderIntentFacetSelectors());
        items[55] = Item("aggregatorAdapterFactoryFacet", address(new AggregatorAdapterFactoryFacet()), _getAggregatorAdapterFactorySelectors());
        items[56] = Item("backstopFacet", address(new BackstopFacet()), _getBackstopFacetSelectors());
        items[57] = Item("riskSplitLiquidationFacet", address(new RiskSplitLiquidationFacet()), _getRiskSplitLiquidationSelectors());
        items[58] = Item("numeraireConfigFacet", address(new NumeraireConfigFacet()), _getNumeraireConfigSelectors());
        items[59] = Item("receiverFacet", address(new ReceiverFacet()), _getReceiverFacetSelectors());
        items[60] = Item("riskAccessFacet", address(new RiskAccessFacet()), _getRiskAccessFacetSelectors());
        items[61] = Item("rewardRemittanceFacet", address(new RewardRemittanceFacet()), _getRewardRemittanceSelectors());
        items[62] = Item("offerPreviewFacet", address(new OfferPreviewFacet()), _getOfferPreviewSelectors());

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](N * 2);
        uint256 nCuts;
        for (uint256 i; i < N; ++i) {
            (bytes4[] memory adds, bytes4[] memory reps) = _split(loupe, items[i].selectors);
            if (reps.length > 0) {
                cuts[nCuts++] = IDiamondCut.FacetCut({
                    facetAddress: items[i].impl,
                    action: IDiamondCut.FacetCutAction.Replace,
                    functionSelectors: reps
                });
            }
            if (adds.length > 0) {
                cuts[nCuts++] = IDiamondCut.FacetCut({
                    facetAddress: items[i].impl,
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: adds
                });
            }
            console.log(items[i].key, items[i].impl);
            console.log("   replace:", reps.length, "add:", adds.length);
        }
        IDiamondCut.FacetCut[] memory finalCuts = new IDiamondCut.FacetCut[](nCuts);
        for (uint256 i; i < nCuts; ++i) {
            finalCuts[i] = cuts[i];
        }
        IDiamondCut(diamond).diamondCut(finalCuts, address(0), "");

        vm.stopBroadcast();

        for (uint256 i; i < N; ++i) {
            for (uint256 j; j < items[i].selectors.length; ++j) {
                address routed = loupe.facetAddress(items[i].selectors[j]);
                require(routed == items[i].impl, string.concat("verify failed: ", items[i].key));
            }
        }
        console.log("Verified: all selectors route to the fresh implementations.");

        for (uint256 i; i < N; ++i) {
            Deployments.writeFacet(items[i].key, items[i].impl);
        }
        console.log("");
        console.log("addresses.json updated. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
        console.log("Then re-verify a sanctions-swept path, e.g. swapToRepayFull");
        console.log("still simulates for an unflagged wallet.");
    }

    function _split(IDiamondLoupe loupe, bytes4[] memory sels)
        private
        view
        returns (bytes4[] memory adds, bytes4[] memory reps)
    {
        uint256 nAdd;
        for (uint256 i; i < sels.length; ++i) {
            if (loupe.facetAddress(sels[i]) == address(0)) nAdd++;
        }
        adds = new bytes4[](nAdd);
        reps = new bytes4[](sels.length - nAdd);
        uint256 ai;
        uint256 ri;
        for (uint256 i; i < sels.length; ++i) {
            if (loupe.facetAddress(sels[i]) == address(0)) {
                adds[ai++] = sels[i];
            } else {
                reps[ri++] = sels[i];
            }
        }
    }
}
