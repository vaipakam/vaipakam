// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {RefreshAllFacetsInPlace} from "../../script/RefreshAllFacetsInPlace.s.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";

/// @dev Exposes the refresh's stale-route classification and sweep, which
///      `refresh()` runs after its post-cut verification.
contract StaleRouteSweepProbe is RefreshAllFacetsInPlace {
    function staleRoutes(IDiamondLoupe loupe, Item[] memory items)
        external
        view
        returns (bytes4[] memory, address[] memory)
    {
        return _staleRoutes(loupe, items);
    }

    function sweep(address diamond, Item[] memory items) external {
        _sweepStaleRoutes(diamond, IDiamondLoupe(diamond), items);
    }
}

/// @dev Stands in for a facet a retired signature was last cut to. The two
///      functions are what the selectors name; the Diamond routes them here.
contract RetiredShapesFacet {
    function acceptOfferRetiredShape(uint256) external pure returns (uint256) {
        return 1;
    }

    function onRewardHookRetiredShape(uint256, uint256) external pure returns (uint256) {
        return 2;
    }
}

/**
 * @title  RefreshStaleRouteSweepTest
 * @notice #2313. A complete in-place refresh must leave the Diamond routing
 *         exactly the deploy's selector set. Base Sepolia carried eleven
 *         retired selectors through the 2026-10-03 refresh, because removal
 *         was driven by hand-kept lists that did not name them. The refresh now
 *         derives what to remove from the loupe; this suite pins that rule.
 *
 * @dev    The state a refresh's sweep meets is modelled from a real
 *         `DeployDiamond` build: after the cuts, every current selector routes
 *         to "this run's implementations", which here are the deployed
 *         Diamond's own facets. The refresh's `items[]` is pinned to the same
 *         selector set by `RefreshScriptFacetParityTest`, so the two halves
 *         together cover the production classification.
 */
contract RefreshStaleRouteSweepTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal constant TREASURY = address(0xBEEF);

    address internal diamond;
    IDiamondLoupe internal loupe;
    StaleRouteSweepProbe internal probe;
    RefreshAllFacetsInPlace.Item[] internal postCut;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        deployScript.runWith(vm.addr(DEPLOYER_KEY), TREASURY, DEPLOYER_KEY);
        diamond = deployScript.diamond();
        loupe = IDiamondLoupe(diamond);
        probe = new StaleRouteSweepProbe();

        // The post-cut `items[]`: one per facet the Diamond routes, except the
        // constructor-installed DiamondCutFacet, which no refresh lists.
        IDiamondLoupe.Facet[] memory live = loupe.facets();
        for (uint256 i; i < live.length; ++i) {
            if (_onlyDiamondCut(live[i].functionSelectors)) continue;
            postCut.push(RefreshAllFacetsInPlace.Item("", live[i].facetAddress, live[i].functionSelectors));
        }
        assertGt(postCut.length, 0, "the deploy routed no facets");

        // The sweep broadcasts its Remove from the script contract, which a
        // real run does as the Diamond's owner.
        vm.prank(OwnershipFacet(diamond).owner());
        OwnershipFacet(diamond).transferOwnership(address(probe));
    }

    /// A Diamond that routes exactly the deploy's set has nothing stale, and
    /// the sweep sends no cut at all.
    function test_CleanDiamond_NothingStale_NoCutSent() public {
        (bytes4[] memory stale,) = probe.staleRoutes(loupe, postCut);
        assertEq(stale.length, 0, "a freshly deployed Diamond reported a stale route");

        vm.recordLogs();
        probe.sweep(diamond, postCut);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 cutTopic = keccak256("DiamondCut((address,uint8,bytes4[])[],address,bytes)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != cutTopic, "a clean sweep sent a diamondCut");
        }
    }

    /// Retired signatures routed to older bytecode, which no list names, are
    /// classified stale with the implementation they still point at, then
    /// removed; every current selector keeps its route.
    function test_RetiredRoutes_AreFound_AndRemoved_CurrentRoutesKept() public {
        address old = address(new RetiredShapesFacet());
        bytes4[] memory retired = new bytes4[](2);
        retired[0] = RetiredShapesFacet.acceptOfferRetiredShape.selector;
        retired[1] = RetiredShapesFacet.onRewardHookRetiredShape.selector;
        _cut(old, IDiamondCut.FacetCutAction.Add, retired);

        (bytes4[] memory stale, address[] memory from) = probe.staleRoutes(loupe, postCut);
        assertEq(stale.length, 2, "the two retired routes were not both found");
        for (uint256 i; i < stale.length; ++i) {
            assertTrue(stale[i] == retired[0] || stale[i] == retired[1], "a current selector was classified stale");
            assertEq(from[i], old, "a stale route was reported against the wrong implementation");
        }

        probe.sweep(diamond, postCut);

        assertEq(loupe.facetAddress(retired[0]), address(0), "a retired route survived the sweep");
        assertEq(loupe.facetAddress(retired[1]), address(0), "a retired route survived the sweep");
        (bool ok,) = diamond.call(abi.encodeWithSelector(retired[0], uint256(7)));
        assertFalse(ok, "the retired entry point is still callable through the Diamond");
        for (uint256 i; i < postCut.length; ++i) {
            for (uint256 j; j < postCut[i].selectors.length; ++j) {
                assertEq(
                    loupe.facetAddress(postCut[i].selectors[j]),
                    postCut[i].impl,
                    "the sweep moved or removed a current route"
                );
            }
        }
        assertTrue(
            loupe.facetAddress(IDiamondCut.diamondCut.selector) != address(0),
            "the sweep removed the constructor-installed diamondCut"
        );
        (stale,) = probe.staleRoutes(loupe, postCut);
        assertEq(stale.length, 0, "a second pass still finds stale routes");
    }

    /// A CURRENT selector found off this run's implementations means the cut
    /// did not land as built. Removing it would unroute a live function, so
    /// the classification refuses instead.
    function test_CurrentSelectorOffThisRunsImplementations_Refuses() public {
        address old = address(new RetiredShapesFacet());
        // Any current selector will do, except the loupe's and ownership's:
        // moving those would break the read or the cut this test drives.
        address loupeFacet = loupe.facetAddress(IDiamondLoupe.facets.selector);
        address ownershipFacet = loupe.facetAddress(OwnershipFacet.owner.selector);
        uint256 k;
        while (postCut[k].impl == loupeFacet || postCut[k].impl == ownershipFacet) ++k;
        bytes4[] memory moved = new bytes4[](1);
        moved[0] = postCut[k].selectors[0];
        _cut(old, IDiamondCut.FacetCutAction.Replace, moved);

        vm.expectRevert(bytes("RefreshAllFacetsInPlace: a current selector is routed off this run's implementations"));
        probe.staleRoutes(loupe, postCut);
    }

    /// More stale routes than one cut's selector budget are removed in
    /// several cuts, and none is left behind.
    function test_ManyRetiredRoutes_RemovedAcrossBudgetedCuts() public {
        address old = address(new RetiredShapesFacet());
        uint256 n = 130; // above the 120-selector budget
        bytes4[] memory retired = new bytes4[](n);
        for (uint256 i; i < n; ++i) retired[i] = bytes4(keccak256(abi.encode("retired", i)));
        _cut(old, IDiamondCut.FacetCutAction.Add, retired);

        probe.sweep(diamond, postCut);
        for (uint256 i; i < n; ++i) {
            assertEq(loupe.facetAddress(retired[i]), address(0), "a retired route past the first batch survived");
        }
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels) private {
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({facetAddress: facet, action: action, functionSelectors: sels});
        vm.prank(address(probe));
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }

    function _onlyDiamondCut(bytes4[] memory sels) private pure returns (bool) {
        for (uint256 i; i < sels.length; ++i) {
            if (sels[i] != IDiamondCut.diamondCut.selector) return false;
        }
        return true;
    }
}
