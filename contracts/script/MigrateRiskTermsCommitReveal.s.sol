// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
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
 *         Scope: this script performs the full security migration — kill the legacy
 *         bump, wire the new commit/reveal entrypoints, AND refresh the hash-aware
 *         accept path (`OfferAcceptFacet` injects `acceptAckTermsHash`; `LoanFacet`
 *         runs the inlined gate hash check) so the new anchor is actually enforced
 *         (Codex #736 r10). A bytecode `Replace` of the diamond's OTHER existing
 *         RiskAccess selectors (tier / consent setters + views) against the
 *         freshly-deployed facet is a separate operator refresh step.
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

        IDiamondLoupe loupe = IDiamondLoupe(diamond);

        // Legacy single-call bump selectors to REMOVE (those actually routed).
        bytes4[2] memory legacy = [
            bytes4(keccak256("bumpRiskTermsVersion()")),
            bytes4(keccak256("bumpRiskTermsVersion(bytes32)"))
        ];
        // The commit/reveal surface to wire. A prior interim build may ALREADY
        // route some of these (e.g. `getCurrentRiskTermsHash` from the hash-based
        // build), so each is REPLACEd if routed and ADDed otherwise — a blanket Add
        // would revert when a selector already has a facet (Codex #736 r9).
        bytes4[4] memory surface = [
            RiskAccessFacet.commitRiskTermsBump.selector,
            RiskAccessFacet.revealRiskTermsBump.selector,
            RiskAccessFacet.getCurrentRiskTermsHash.selector,
            RiskAccessFacet.getPendingRiskTermsCommitment.selector
        ];

        uint256 nRemove = _countRouted(loupe, legacy, true);
        uint256 nReplace = _countRouted(loupe, surface, true);
        uint256 nAdd = surface.length - nReplace;

        vm.startBroadcast(deployerKey);

        RiskAccessFacet riskAccessFacet = new RiskAccessFacet();
        console.log("New RiskAccessFacet:", address(riskAccessFacet));

        uint256 nCuts =
            (nRemove > 0 ? 1 : 0) + (nReplace > 0 ? 1 : 0) + (nAdd > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](nCuts);
        uint256 ci;

        if (nRemove > 0) {
            cuts[ci++] = IDiamondCut.FacetCut({
                facetAddress: address(0), // Remove ⇒ zero facet address
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: _routedSubset(loupe, legacy, true, nRemove)
            });
        }
        if (nReplace > 0) {
            cuts[ci++] = IDiamondCut.FacetCut({
                facetAddress: address(riskAccessFacet),
                action: IDiamondCut.FacetCutAction.Replace,
                functionSelectors: _routedSubset(loupe, surface, true, nReplace)
            });
        }
        if (nAdd > 0) {
            cuts[ci] = IDiamondCut.FacetCut({
                facetAddress: address(riskAccessFacet),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: _routedSubset(loupe, surface, false, nAdd)
            });
        }

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        // #736 r10 — the hash-aware accept path lives in OfferAcceptFacet (injects
        // `acceptAckTermsHash`) and LoanFacet (runs the inlined
        // `LibRiskAccess.assertAcceptorMayTransact` hash check). Upgrading only the
        // RiskAccess selectors would leave the stale accept/loan bytecode in place,
        // so the new anchor wouldn't be enforced (and updated frontends could hit a
        // stale `acceptOffer`). Refresh both facets' bytecode in the same upgrade by
        // Replacing every selector currently routed to their old addresses.
        _refreshFacetBytecode(
            diamond, loupe, OfferAcceptFacet.acceptOffer.selector,
            address(new OfferAcceptFacet())
        );
        _refreshFacetBytecode(
            diamond, loupe, LoanFacet.initiateLoan.selector,
            address(new LoanFacet())
        );

        vm.stopBroadcast();

        console.log("Legacy bump selectors removed:", nRemove);
        console.log("Commit/reveal selectors replaced:", nReplace);
        console.log("Commit/reveal selectors added:   ", nAdd);
        console.log("Refreshed OfferAcceptFacet + LoanFacet bytecode");
    }

    /// @dev Replace every selector currently routed to the facet that owns `probe`
    ///      with `newFacet`'s freshly-deployed bytecode (a generic facet-bytecode
    ///      refresh). Reverts if `probe` isn't routed (the facet must be present to
    ///      refresh).
    function _refreshFacetBytecode(
        address diamond,
        IDiamondLoupe loupe,
        bytes4 probe,
        address newFacet
    ) private {
        address oldFacet = loupe.facetAddress(probe);
        require(oldFacet != address(0), "migration: accept-path facet not routed");
        bytes4[] memory sels = loupe.facetFunctionSelectors(oldFacet);
        IDiamondCut.FacetCut[] memory c = new IDiamondCut.FacetCut[](1);
        c[0] = IDiamondCut.FacetCut({
            facetAddress: newFacet,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sels
        });
        IDiamondCut(diamond).diamondCut(c, address(0), "");
    }

    /// @dev Count selectors in `sels` whose routed-state matches `wantRouted`.
    function _countRouted(
        IDiamondLoupe loupe,
        bytes4[2] memory sels,
        bool wantRouted
    ) private view returns (uint256 n) {
        for (uint256 i; i < sels.length; i++) {
            if ((loupe.facetAddress(sels[i]) != address(0)) == wantRouted) n++;
        }
    }

    function _countRouted(
        IDiamondLoupe loupe,
        bytes4[4] memory sels,
        bool wantRouted
    ) private view returns (uint256 n) {
        for (uint256 i; i < sels.length; i++) {
            if ((loupe.facetAddress(sels[i]) != address(0)) == wantRouted) n++;
        }
    }

    /// @dev The subset of `sels` whose routed-state matches `wantRouted`, of length
    ///      `n` (caller passes the pre-counted size).
    function _routedSubset(
        IDiamondLoupe loupe,
        bytes4[2] memory sels,
        bool wantRouted,
        uint256 n
    ) private view returns (bytes4[] memory out) {
        out = new bytes4[](n);
        uint256 k;
        for (uint256 i; i < sels.length; i++) {
            if ((loupe.facetAddress(sels[i]) != address(0)) == wantRouted) {
                out[k++] = sels[i];
            }
        }
    }

    function _routedSubset(
        IDiamondLoupe loupe,
        bytes4[4] memory sels,
        bool wantRouted,
        uint256 n
    ) private view returns (bytes4[] memory out) {
        out = new bytes4[](n);
        uint256 k;
        for (uint256 i; i < sels.length; i++) {
            if ((loupe.facetAddress(sels[i]) != address(0)) == wantRouted) {
                out[k++] = sels[i];
            }
        }
    }
}
