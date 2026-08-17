// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {RefreshAllFacetsInPlace} from "../../script/RefreshAllFacetsInPlace.s.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title  RefreshScriptFacetParityTest
 * @notice #1793 guardrail. Asserts `RefreshAllFacetsInPlace.EXPECTED_FACETS`
 *         equals the number of facets the Diamond is actually built from, so a
 *         facet added to `DeployDiamond` but not mirrored into the in-place
 *         refresh script fails CI instead of failing a live redeploy.
 *
 * @dev    Why this cannot live inside the script. `refresh()` already guards
 *         itself:
 *
 *             require(items.length == EXPECTED_FACETS,
 *                     "RefreshAllFacetsInPlace: facet count drift vs DeployDiamond");
 *
 *         The message says "vs DeployDiamond", but the comparison is against the
 *         script's OWN constant. Adding a facet to `DeployDiamond` and touching
 *         neither `_deployItems()` nor `EXPECTED_FACETS` — the natural way to
 *         forget one, since you edit neither line — leaves that require
 *         satisfied. The script then refreshes every facet EXCEPT the new one,
 *         which keeps running pre-change bytecode while everything around it
 *         moves on: the half-applied-family hazard the script's own header warns
 *         about for paired facets.
 *
 *         That is not hypothetical. #1780 added `EarlyWithdrawalDirectFacet` and
 *         missed this script; the deploy-sanity suite, the excision gate and a
 *         full local `predeploy-check.sh` all passed green with it missing, and
 *         only Codex's review caught it (#1791 F1). A guard that compares a
 *         constant against itself is not a guard.
 *
 *         So the cross-check has to sit where BOTH lists are visible, and that
 *         is the test layer. The dependency direction is the point: a production
 *         refresh script must not import `test/` to validate itself, whereas a
 *         test may freely import the script. Hence `EXPECTED_FACETS` is
 *         `public` (a constant, so the getter costs nothing and no behaviour
 *         changes) and this test reads it from outside.
 *
 *         Ground truth is `DiamondFacetNames.cutFacetNames()`, which the suite
 *         already documents as mirroring `DeployDiamond`'s `cuts[]` and which
 *         `SelectorCoverageTest` independently cross-checks against the
 *         compiled facet ABIs. So this test inherits that list's correctness
 *         rather than introducing a third hand-maintained count.
 *
 *         NOT covered here, and deliberately: whether every cut facet also gets
 *         a `Deployments.writeFacet(...)` call (#1791 F2). Solidity cannot see
 *         whether a call exists in a script's body; that check belongs in
 *         `predeploy-check.sh`, comparing written keys against this same list.
 *         Tracked in #1793.
 */
contract RefreshScriptFacetParityTest is Test, DiamondFacetNames {
    function test_RefreshScript_FacetCount_MatchesDiamond() public {
        uint256 refreshExpects = new RefreshAllFacetsInPlace().EXPECTED_FACETS();
        uint256 diamondHas = cutFacetNames().length;

        assertEq(
            refreshExpects,
            diamondHas,
            "facet-count drift: RefreshAllFacetsInPlace is out of step with the "
            "Diamond. Adding a facet needs BOTH an items[] entry in "
            "_deployItems() AND a bump to EXPECTED_FACETS in "
            "script/RefreshAllFacetsInPlace.s.sol. The script's own require "
            "cannot catch this (it compares that constant against itself) - "
            "see #1793."
        );
    }
}
