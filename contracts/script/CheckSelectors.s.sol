// scripts/CheckSelectors.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";

// Add imports for other facets as needed, e.g., import "../src/facets/ProfileFacet.sol";

contract CheckSelectors is Script {
    function run() external view {
        // Get and log selectors for each facet
        logSelectors("OfferFacet", getOfferFacetSelectors());
        logSelectors("RepayFacet", getRepayFacetSelectors());
        logSelectors("DefaultedFacet", getDefaultedFacetSelectors());
        // Repeat for other facets: Profile, Risk, etc.
    }

    /**
     * @dev Logs all selectors for a facet to console for duplicate checking.
     * @param facetName Name for logging.
     * @param selectors Array of selectors.
     */
    function logSelectors(
        string memory facetName,
        bytes4[] memory selectors
    ) internal pure {
        console.log("Selectors for %s:", facetName);
        for (uint256 i = 0; i < selectors.length; i++) {
            console.logBytes4(selectors[i]);
        }
        console.log("---"); // Separator
    }

    // Facet-specific selector getters (list all public/external manually)
    function getOfferFacetSelectors()
        internal
        pure
        returns (bytes4[] memory selectors)
    {
        // OfferFacet split: cancelOffer + getCompatibleOffers moved
        // to OfferCancelFacet for the EIP-170 split.
        selectors = new bytes4[](5);
        selectors[0] = OfferCreateFacet.createOffer.selector;
        selectors[1] = OfferAcceptFacet.acceptOffer.selector;
        selectors[2] = OfferCreateFacet.getUserVault.selector;
        selectors[3] = OfferCancelFacet.cancelOffer.selector;
        selectors[4] = OfferCancelFacet.getCompatibleOffers.selector;
        // selectors[5] = OfferFacet._simulateLTV.selector;
        // selectors[6] = OfferFacet._calculateCurrentBorrowBalance.selector;
        // selectors[7] = OfferFacet._calculateTransactionValueNumeraire.selector;
        // Add more if needed, e.g., selectors[4] = OfferFacet.tokenURI.selector;
    }

    function getRepayFacetSelectors()
        internal
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4); // Adjust count
        selectors[0] = RepayFacet.repayLoan.selector;
        selectors[1] = RepayFacet.repayPartial.selector;
        // Issue #66 — autoDeductDaily moved to RepayPeriodicFacet.
        selectors[2] = RepayPeriodicFacet.autoDeductDaily.selector;
        selectors[3] = RepayFacet.calculateRepaymentAmount.selector;
    }

    function getDefaultedFacetSelectors()
        internal
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2); // Adjust count
        selectors[0] = DefaultedFacet.triggerDefault.selector;
        selectors[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    // Add similar functions for other facets, e.g., getProfileFacetSelectors() { ... ProfileFacet.setTradeAllowance.selector; ... }
}
