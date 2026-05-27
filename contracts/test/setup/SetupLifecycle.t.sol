// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupLoans} from "./SetupLoans.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";
import {EarlyWithdrawalFacet} from "../../src/facets/EarlyWithdrawalFacet.sol";
import {PartialWithdrawalFacet} from "../../src/facets/PartialWithdrawalFacet.sol";

/// @title SetupLifecycle — SetupLoans + the 4 lifecycle facets.
/// @notice Adds Preclose, Refinance, EarlyWithdrawal, and Partial-withdrawal
///         on top of the loan flow. Target tests: `PrecloseFacetTest`,
///         `RefinanceFacetTest`, `EarlyWithdrawalFacetTest`,
///         `PartialWithdrawalFacetTest`.
///
/// @dev Compile cost: 25 facet TYPE imports vs the old `SetupTest`'s 39.
///
/// @dev When PR #288 (T-086 step 5) merges, this base will gain a
///      one-line follow-up adding `PrepayListingFacet` to the cuts[] —
///      tracked as a known follow-up against this commit.
abstract contract SetupLifecycle is SetupLoans {
    PrecloseFacet internal precloseFacet;
    RefinanceFacet internal refinanceFacet;
    EarlyWithdrawalFacet internal earlyWithdrawalFacet;
    PartialWithdrawalFacet internal partialWithdrawalFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupLoans → SetupOffers → SetupCore → TestBase

        precloseFacet = new PrecloseFacet();
        refinanceFacet = new RefinanceFacet();
        earlyWithdrawalFacet = new EarlyWithdrawalFacet();
        partialWithdrawalFacet = new PartialWithdrawalFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(precloseFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPrecloseFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(refinanceFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRefinanceFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(earlyWithdrawalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEarlyWithdrawalFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(partialWithdrawalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPartialWithdrawalFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
