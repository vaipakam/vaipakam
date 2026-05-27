// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../../src/facets/OfferMatchFacet.sol";
import {OfferMutateFacet} from "../../src/facets/OfferMutateFacet.sol";

/// @title SetupOffers — SetupCore + 5 Offer facets.
/// @notice Adds the offer-creation / acceptance / cancellation / matching /
///         mutation surface on top of Core. Used by tests that exercise the
///         offer book without yet entering the loan lifecycle.
///
/// @dev Compile cost: 13 facet TYPE imports (8 from Core + 5 here) vs the
///      old `SetupTest`'s 39. Target tests for migration: `OfferFacetTest`,
///      `OfferCancelTest`, `OfferMatchTest`, `OfferModificationTest`,
///      `BorrowerPartialFillTest`, `PreviewAcceptTest`.
abstract contract SetupOffers is SetupCore {
    OfferCreateFacet internal offerCreateFacet;
    OfferAcceptFacet internal offerAcceptFacet;
    OfferCancelFacet internal offerCancelFacet;
    OfferMatchFacet internal offerMatchFacet;
    OfferMutateFacet internal offerMutateFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupCore → TestBase

        offerCreateFacet = new OfferCreateFacet();
        offerAcceptFacet = new OfferAcceptFacet();
        offerCancelFacet = new OfferCancelFacet();
        offerMatchFacet = new OfferMatchFacet();
        offerMutateFacet = new OfferMutateFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(offerCancelFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCancelFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(offerMatchFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferMatchFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(offerMutateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferMutateFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
