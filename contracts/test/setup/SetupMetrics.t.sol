// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../../src/facets/MetricsDashboardFacet.sol";

/// @title SetupMetrics — SetupCore + the 2 metrics facets.
/// @notice Target tests: `MetricsFacetTest`, `MetricsDashboardFacetTest`,
///         `MetricsRevenueByAssetTest`. None of these exercise actual loan /
///         offer state — they hit read-only metric surfaces — so the 10-facet
///         footprint is sufficient.
///
/// @dev Compile cost: 10 facet TYPE imports vs the old `SetupTest`'s 39.
abstract contract SetupMetrics is SetupCore {
    MetricsFacet internal metricsFacet;
    MetricsDashboardFacet internal metricsDashboardFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupCore → TestBase

        metricsFacet = new MetricsFacet();
        metricsDashboardFacet = new MetricsDashboardFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(metricsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getMetricsFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(metricsDashboardFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getMetricsDashboardFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
