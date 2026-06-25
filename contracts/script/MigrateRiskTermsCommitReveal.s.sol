// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title MigrateRiskTermsCommitReveal
 * @notice #730 / Codex #736 r8 — upgrade an EXISTING diamond that routed a legacy
 *         single-call `bumpRiskTermsVersion()` / `bumpRiskTermsVersion(bytes32)`
 *         terms-bump selector to the commit-reveal terms-publishing surface, and
 *         CRITICALLY **Remove** the legacy selector(s).
 *
 *         A diamond `Replace`/`Add` cut never deletes a selector that is merely
 *         omitted from the new list, so without an explicit `Remove` the legacy
 *         bump would stay callable on an in-place upgrade — and the legacy bump
 *         advances `currentRiskTermsVersion` WITHOUT changing `currentRiskTermsHash`,
 *         which lets a pre-change `AcceptTerms` (stamped with the unchanged anchor)
 *         still satisfy the accept gate after a user re-affirms only their tier,
 *         bypassing the freshness re-lock this whole change adds.
 *
 *         A fresh `DeployDiamond` never routes the legacy selector (its
 *         `_getRiskAccessFacetSelectors` lists only commit/reveal), and
 *         `DeployDiamondIntegrationTest.test_DeployedDiamond_LegacyTermsBumpSelectorsUnrouted`
 *         enforces that. This script is therefore ONLY for in-place upgrades; no
 *         live diamond carries the legacy selector today (the platform is pre-live).
 *         The `Remove` is loupe-guarded to the selectors actually present, so the
 *         script is a safe no-op-Remove on a diamond that never had them.
 *
 *         Scope: this script performs the load-bearing security migration — kill
 *         the legacy bump + wire the new commit/reveal entrypoints. A bytecode
 *         `Replace` of the diamond's other existing RiskAccess selectors against
 *         the freshly-deployed facet is a separate operator refresh step.
 *
 * Env vars: DEPLOYER_PRIVATE_KEY (+ Deployments-resolved DIAMOND_ADDRESS).
 *
 * Usage:
 *   forge script script/MigrateRiskTermsCommitReveal.s.sol \
 *     --rpc-url $RPC_URL --broadcast -vvv
 */
contract MigrateRiskTermsCommitReveal is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        console.log("Diamond:", diamond);

        // Which legacy bump selectors does the live diamond currently route?
        bytes4[2] memory legacy = [
            bytes4(keccak256("bumpRiskTermsVersion()")),
            bytes4(keccak256("bumpRiskTermsVersion(bytes32)"))
        ];
        IDiamondLoupe loupe = IDiamondLoupe(diamond);
        uint256 nRemove;
        for (uint256 i; i < legacy.length; i++) {
            if (loupe.facetAddress(legacy[i]) != address(0)) nRemove++;
        }

        vm.startBroadcast(deployerKey);

        RiskAccessFacet riskAccessFacet = new RiskAccessFacet();
        console.log("New RiskAccessFacet:", address(riskAccessFacet));

        // [Remove legacy bump (if routed)] + [Add commit/reveal surface].
        IDiamondCut.FacetCut[] memory cuts =
            new IDiamondCut.FacetCut[](nRemove > 0 ? 2 : 1);
        uint256 ci;
        if (nRemove > 0) {
            bytes4[] memory rem = new bytes4[](nRemove);
            uint256 k;
            for (uint256 i; i < legacy.length; i++) {
                if (loupe.facetAddress(legacy[i]) != address(0)) rem[k++] = legacy[i];
            }
            cuts[ci++] = IDiamondCut.FacetCut({
                facetAddress: address(0), // Remove ⇒ zero facet address
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: rem
            });
        }
        bytes4[] memory add = new bytes4[](4);
        add[0] = RiskAccessFacet.commitRiskTermsBump.selector;
        add[1] = RiskAccessFacet.revealRiskTermsBump.selector;
        add[2] = RiskAccessFacet.getCurrentRiskTermsHash.selector;
        add[3] = RiskAccessFacet.getPendingRiskTermsCommitment.selector;
        cuts[ci] = IDiamondCut.FacetCut({
            facetAddress: address(riskAccessFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: add
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        console.log("Legacy bump selectors removed:", nRemove);
        console.log("commit/reveal surface added: 4 selectors");
    }
}
