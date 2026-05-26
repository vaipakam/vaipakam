// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LegalFacet} from "../../src/facets/LegalFacet.sol";

/// @title SetupConfig — SetupCore + ConfigFacet + LegalFacet.
/// @notice Narrow base for config / legal-surface tests. Carries the 8
///         core facets + the 2 config-area facets. No mock tokens, no
///         risk params, no oracle mocks — those belong to flow bases
///         (SetupOffers / SetupLoans / ...).
///
/// @dev Compile cost: 10 facet TYPE imports (8 from Core + 2 here) vs the
///      old `SetupTest`'s 39. The inheriting test contract's IR only
///      flattens these 10 facet types.
///
///      Target tests for migration: `ConfigFacetTest`, `LegalFacetTest`,
///      `LibFeesConfigTest`, any test asserting only `set*Config(...)`
///      surface behaviour.
abstract contract SetupConfig is SetupCore {
    ConfigFacet internal configFacet;
    LegalFacet internal legalFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupCore → TestBase

        configFacet = new ConfigFacet();
        legalFacet = new LegalFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(configFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getConfigFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(legalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getLegalFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
