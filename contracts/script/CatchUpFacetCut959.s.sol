// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "./DeployDiamond.s.sol";
import {Deployments} from "./lib/Deployments.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";

/**
 * @title CatchUpFacetCut959
 * @notice One-shot TESTNET catch-up cut that brings an already-deployed
 *         Diamond (whose last facet refresh was the #953 tranche) up to
 *         current `main` for the three contract PRs merged since:
 *
 *           - #978 (#921 item 5) — ConfigFacet `minPartialBps` setter +
 *             RiskParams view (new selectors), RepayFacet enforcement.
 *           - #979 (#921 item 4) — MetricsFacet public `getOfferState`
 *             (new selector).
 *           - #959 (#951 fix)   — createLoanSaleOffer succeeds on-chain:
 *             EarlyWithdrawalFacet internal-create reroute, OfferCreate
 *             ceiling exemption, the offer-facet refactor batch, and the
 *             NEW OfferPreviewFacet (added wholesale).
 *
 *         Facet set (15): the facets those PRs changed directly, PLUS
 *         Preclose / Refinance / RiskAccess, which import the changed
 *         `LibOfferMatch` / `LibSaleListing` internals — inlined-library
 *         bytecode must not straddle a cut boundary (see the rollout
 *         warning in RedeployFacets.s.sol). BackstopFacet also imports
 *         LibOfferMatch but is NOT cut on the testnet Diamonds
 *         (absent from addresses.json), so it is deliberately skipped.
 *
 *         Selector lists are INHERITED from `DeployDiamond.s.sol`
 *         (`_get<Facet>Selectors()` — CI-guarded by SelectorCoverageTest),
 *         so this script cannot drift from the canonical routing. Each
 *         facet's list is split at runtime against the live loupe:
 *         already-routed selectors become Replace, unrouted ones become
 *         Add (covers the brand-new OfferPreviewFacet and the #978/#979
 *         selector additions automatically). After the cut, every
 *         selector is verified via the loupe and the new facet addresses
 *         are persisted to `deployments/<slug>/addresses.json`.
 *
 * @dev   TESTNET ONLY — mainnet-grade rollouts use the fresh
 *        `DeployDiamond.s.sol` path per the 2026-06-19 owner policy.
 *
 *        Env: DEPLOYER_PRIVATE_KEY (must be the Diamond owner — same key
 *        used for the #953 cut).
 *
 *        Usage (from contracts/, on main):
 *          forge script script/CatchUpFacetCut959.s.sol \
 *            --sig "catchUp()" --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
 *        then the same with $ARB_SEPOLIA_RPC_URL.
 */
contract CatchUpFacetCut959 is DeployDiamond {
    struct Item {
        string key; // addresses.json facet key
        address impl; // freshly deployed implementation
        bytes4[] selectors; // canonical routing per DeployDiamond
    }

    function catchUp() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 421614 || cid == 97 || cid == 11155111 || cid == 11155420 || cid == 31337,
            "CatchUpFacetCut959: testnet only"
        );
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        IDiamondLoupe loupe = IDiamondLoupe(diamond);

        console.log("=== Catch-up facet cut (#978 + #979 + #959) ===");
        console.log("Chain id:", cid);
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);

        Item[] memory items = new Item[](15);
        items[0] = Item("offerCreateFacet", address(new OfferCreateFacet()), _getOfferCreateSelectors());
        items[1] = Item("offerAcceptFacet", address(new OfferAcceptFacet()), _getOfferAcceptSelectors());
        items[2] = Item("offerPreviewFacet", address(new OfferPreviewFacet()), _getOfferPreviewSelectors());
        items[3] = Item("offerMatchFacet", address(new OfferMatchFacet()), _getOfferMatchSelectors());
        items[4] = Item("offerCancelFacet", address(new OfferCancelFacet()), _getOfferCancelSelectors());
        items[5] = Item("offerMutateFacet", address(new OfferMutateFacet()), _getOfferMutateSelectors());
        items[6] = Item("loanFacet", address(new LoanFacet()), _getLoanSelectors());
        items[7] = Item("repayFacet", address(new RepayFacet()), _getRepaySelectors());
        items[8] = Item("earlyWithdrawalFacet", address(new EarlyWithdrawalFacet()), _getEarlyWithdrawalSelectors());
        items[9] = Item(
            "partialWithdrawalFacet", address(new PartialWithdrawalFacet()), _getPartialWithdrawalSelectors()
        );
        items[10] = Item("configFacet", address(new ConfigFacet()), _getConfigSelectors());
        items[11] = Item("metricsFacet", address(new MetricsFacet()), _getMetricsSelectors());
        items[12] = Item("precloseFacet", address(new PrecloseFacet()), _getPrecloseSelectors());
        items[13] = Item("refinanceFacet", address(new RefinanceFacet()), _getRefinanceSelectors());
        items[14] = Item("riskAccessFacet", address(new RiskAccessFacet()), _getRiskAccessFacetSelectors());

        // Split each facet's canonical selector list against the live
        // loupe: routed → Replace, unrouted → Add.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](items.length * 2);
        uint256 nCuts;
        for (uint256 i; i < items.length; ++i) {
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

        // Post-cut verification: every canonical selector must now route
        // to its fresh implementation.
        for (uint256 i; i < items.length; ++i) {
            for (uint256 j; j < items[i].selectors.length; ++j) {
                address routed = loupe.facetAddress(items[i].selectors[j]);
                require(routed == items[i].impl, string.concat("verify failed: ", items[i].key));
            }
        }
        console.log("Verified: all selectors route to the fresh implementations.");

        // Persist the new addresses so the frontend deployments sync
        // picks them up (same artifact discipline as every deploy).
        for (uint256 i; i < items.length; ++i) {
            Deployments.writeFacet(items[i].key, items[i].impl);
        }
        console.log("");
        console.log("addresses.json updated. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
        console.log("  forge build --skip test && bash script/exportFrontendAbis.sh");
        console.log("Then verify the #951 fix:");
        console.log("  createLoanSaleOffer should now simulate cleanly on an active loan.");
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
