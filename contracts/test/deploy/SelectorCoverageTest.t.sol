// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title  SelectorCoverageTest
 * @notice Issue #71 guardrail — two static, pre-deploy checks on the
 *         Diamond's selector routing:
 *
 *         1. `test_DeployDiamond_RoutesEveryFacetSelector` — every
 *            external/public function compiled into a facet is actually
 *            cut into the Diamond by `DeployDiamond.s.sol`.
 *         2. `test_NoSelectorCollisionAcrossFacets` — no two distinct
 *            function signatures across the facet set hash to the same
 *            4-byte selector (a real collision makes `diamondCut`
 *            revert, so the Diamond cannot be deployed at all).
 *
 * @dev    The Diamond's selector -> facet routing is hand-maintained in
 *         the `_get<Facet>Selectors()` lists of `DeployDiamond.s.sol`.
 *         When a new external/public function is added to a facet, its
 *         selector must be added to the matching list by hand. If that
 *         is missed, the function exists on the facet contract but the
 *         Diamond never routes it — every call reverts
 *         `FunctionDoesNotExist`, silently, until runtime. The
 *         `.facetCount` source-of-truth check (Issue #69) catches a
 *         missing whole *facet*; it cannot catch a facet that is present
 *         but missing some of its *selectors*. This test closes that gap.
 *
 *         How the coverage check works — with no second hand-maintained
 *         selector list to drift against:
 *           1. The authoritative selector set of a facet is its compiled
 *              ABI. Each facet artifact (`out/<Facet>.sol/<Facet>.json`)
 *              carries a `methodIdentifiers` object listing every
 *              external/public signature the compiler emitted.
 *           2. This test contract inherits `DeployDiamond`, so it calls
 *              the very same `_get<Facet>Selectors()` lists the real
 *              deploy uses and unions them into one routed set.
 *           3. For every facet, every signature in its `methodIdentifiers`
 *              is hashed to its 4-byte selector and checked against that
 *              routed set.
 *
 *         A *global* routed set (not per-facet) is used deliberately: a
 *         function inherited by several facets — e.g. `supportsInterface`
 *         appears in `DiamondLoupeFacet` and in any ERC-165 facet — is
 *         cut exactly once, under a single owning facet. A per-facet
 *         check would false-positive on the other facets; the global set
 *         does not, while still catching a selector cut by *no* facet.
 *
 *         The facet set comes from the shared `DiamondFacetNames` list,
 *         which both this test and `FacetSizeLimitTest` consume — so the
 *         two guardrails cannot drift onto different facet sets.
 *
 *         Scope: this test guards the production `DeployDiamond` list.
 *         `HelperTest.sol`'s parallel test-Diamond lists are exercised
 *         by every `forge test` run already (a missing selector breaks
 *         whichever test calls it), so they are not re-checked here.
 *
 *         Maintenance: when a facet is added to the Diamond, add it to
 *         `DiamondFacetNames.cutFacetNames()` AND add its
 *         `_get<Facet>Selectors()` call to `_populateRoutedSet()` below.
 */
contract SelectorCoverageTest is Test, DeployDiamond, DiamondFacetNames {
    /// @dev Global set of every selector routed by DeployDiamond's cut
    ///      lists — the union of all `_get<Facet>Selectors()`.
    mapping(bytes4 => bool) private _routed;

    /// @dev Collision tracking — selector -> the first signature seen to
    ///      hash to it. A second, *different* signature hashing to the
    ///      same selector is a 4-byte collision.
    mapping(bytes4 => string) private _firstSigFor;

    // ─── 1. Coverage ──────────────────────────────────────────────────

    /// @notice Every compiled facet selector must be cut into the Diamond.
    function test_DeployDiamond_RoutesEveryFacetSelector() public {
        _populateRoutedSet();

        string[38] memory facets = cutFacetNames();
        uint256 missing;
        for (uint256 i; i < facets.length; ++i) {
            string memory name = facets[i];
            string[] memory sigs = _facetSelectorSignatures(name);
            for (uint256 j; j < sigs.length; ++j) {
                bytes4 sel = bytes4(keccak256(bytes(sigs[j])));
                if (!_routed[sel]) {
                    ++missing;
                    emit log_named_string(
                        string.concat("UNCUT  ", name, " ::"), sigs[j]
                    );
                }
            }
        }
        assertEq(
            missing,
            0,
            "facet function(s) logged above are not cut into the Diamond "
            "by DeployDiamond.s.sol -- add each selector to the matching "
            "_get<Facet>Selectors() list"
        );
    }

    // ─── 2. Collision ─────────────────────────────────────────────────

    /// @notice No two distinct facet function signatures may share a
    ///         4-byte selector — such a collision makes `diamondCut`
    ///         revert and the Diamond undeployable.
    function test_NoSelectorCollisionAcrossFacets() public {
        string[38] memory facets = cutFacetNames();
        uint256 collisions;
        for (uint256 i; i < facets.length; ++i) {
            collisions += _recordAndCountCollisions(facets[i]);
        }
        // `DiamondCutFacet` is absent from `cutFacetNames()` (it is
        // constructor-installed, not cut), but its `diamondCut` selector
        // IS live on the Diamond from construction onward. A facet
        // function colliding with it would make the real `Add` cut
        // revert, so it must be in the collision scan.
        collisions += _recordAndCountCollisions("DiamondCutFacet");
        assertEq(
            collisions,
            0,
            "4-byte selector collision(s) logged above -- two distinct "
            "facet functions hash to the same selector; the Diamond "
            "cannot be cut until one is renamed"
        );
    }

    /// @dev Record a facet's selectors into `_firstSigFor` and count any
    ///      that collide with an already-seen *different* signature. An
    ///      identical signature inherited by two facets is not a
    ///      collision — it is cut once, under one owning facet.
    function _recordAndCountCollisions(string memory facet)
        private
        returns (uint256 found)
    {
        string[] memory sigs = _facetSelectorSignatures(facet);
        for (uint256 j; j < sigs.length; ++j) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[j])));
            string memory seen = _firstSigFor[sel];
            if (bytes(seen).length == 0) {
                _firstSigFor[sel] = sigs[j];
            } else if (keccak256(bytes(seen)) != keccak256(bytes(sigs[j]))) {
                ++found;
                emit log_named_string(
                    "COLLISION  selector clash",
                    string.concat(seen, "  <=>  ", sigs[j])
                );
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    /// @dev Read a facet's full external/public signature set from its
    ///      compiled artifact. forge writes one artifact per source file
    ///      at `out/<File>.sol/<Contract>.json`; for every facet the file
    ///      basename equals the contract name.
    function _facetSelectorSignatures(string memory facet)
        private
        view
        returns (string[] memory)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(
            string.concat("out/", facet, ".sol/", facet, ".json")
        );
        return vm.parseJsonKeys(json, ".methodIdentifiers");
    }

    /// @dev Union every `_get<Facet>Selectors()` list into `_routed`.
    ///      Mirrors the `cuts[0..34]` assignments of `DeployDiamond.run()`
    ///      — keep this in step when a facet is added or removed.
    function _populateRoutedSet() private {
        _addAll(_getLoupeSelectors());
        _addAll(_getOwnershipSelectors());
        _addAll(_getAccessControlSelectors());
        _addAll(_getAdminSelectors());
        _addAll(_getProfileSelectors());
        _addAll(_getOracleSelectors());
        _addAll(_getOracleAdminSelectors());
        _addAll(_getNftSelectors());
        _addAll(_getVaultFactorySelectors());
        _addAll(_getOfferCreateSelectors());
        _addAll(_getOfferAcceptSelectors());
        _addAll(_getLoanSelectors());
        _addAll(_getRepaySelectors());
        _addAll(_getDefaultedSelectors());
        _addAll(_getRiskSelectors());
        _addAll(_getClaimSelectors());
        _addAll(_getAddCollateralSelectors());
        _addAll(_getTreasurySelectors());
        _addAll(_getEarlyWithdrawalSelectors());
        _addAll(_getPartialWithdrawalSelectors());
        _addAll(_getPrecloseSelectors());
        _addAll(_getRefinanceSelectors());
        _addAll(_getMetricsSelectors());
        _addAll(_getVpfiTokenSelectors());
        _addAll(_getVpfiDiscountSelectors());
        _addAll(_getStakingRewardsSelectors());
        _addAll(_getInteractionRewardsSelectors());
        _addAll(_getRewardReporterSelectors());
        _addAll(_getRewardAggregatorSelectors());
        _addAll(_getConfigSelectors());
        _addAll(_getLegalSelectors());
        _addAll(_getOfferMatchSelectors());
        _addAll(_getOfferCancelSelectors());
        // #193 — in-place offer modification facet.
        _addAll(_getOfferMutateSelectors());
        _addAll(_getMetricsDashboardSelectors());
        _addAll(_getPayrollSelectors());
        _addAll(_getRiskMatchLiquidationSelectors());
        // T-086 step 5 — `PrepayListingFacet` (executor↔diamond trust
        // boundary for Seaport prepay collateral sales). Selector
        // helper lives on `DeployDiamond.s.sol` like every other facet.
        _addAll(_getPrepayListingSelectors());
    }

    /// @dev Add a selector list to the routed set, rejecting two faults:
    ///
    ///      - A zero selector — a `bytes4(0)` entry means a
    ///        `_get*Selectors()` array was declared larger than the
    ///        slots it fills (the `new bytes4[](N)` size drifted past
    ///        the `s[i] = ...` assignments), leaving an unwired hole.
    ///      - A duplicate selector — the same selector appearing twice,
    ///        within one `_get*Selectors()` array or across two cut
    ///        lists. `LibDiamond.addFunctions` rejects an `Add` for a
    ///        selector that already maps to a facet, so a duplicate
    ///        makes the real `diamondCut` revert and the cut list
    ///        undeployable. A silent overwrite here would leave the
    ///        coverage test green on an undeployable list.
    function _addAll(bytes4[] memory sels) private {
        for (uint256 i; i < sels.length; ++i) {
            assertTrue(
                sels[i] != bytes4(0),
                "DeployDiamond._get*Selectors() has an unfilled (zero) "
                "slot -- the new bytes4[](N) size exceeds the assignments"
            );
            assertFalse(
                _routed[sels[i]],
                "DeployDiamond's cut lists route the same selector twice "
                "-- diamondCut's Add rejects an already-mapped selector, "
                "so the cut is undeployable; remove the duplicate"
            );
            _routed[sels[i]] = true;
        }
    }
}
