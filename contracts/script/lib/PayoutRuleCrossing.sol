// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {OfferBookFacet} from "../../src/facets/OfferBookFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";

/**
 * @title  PayoutRuleCrossing
 * @notice The one refusal the curated in-place refreshes take against a
 *         Diamond from before the payout rule and the offer-holder rule
 *         (#3744, owner decision 2026-11-19). From that boundary every offer
 *         step asks one holder rule (`OfferBookFacet.requireOfferHolder`,
 *         self-called from ProfileFacet's offer settings among others) and an
 *         accept refunds residual escrow through one host
 *         (`OfferCancelFacet.refundOfferEscrow`). A curated refresh replaces
 *         some callers without those hosts, so a refreshed caller would revert
 *         `FunctionDoesNotExist` on an unrouted self-call. The payout rule is
 *         fresh-deploy material like the position state guard it extends, so
 *         the crossing is a fresh deploy or the all-facets refresh, never a
 *         curated subset.
 */
library PayoutRuleCrossing {
    /// @notice The target Diamond predates the payout and offer-holder rule.
    error PredatesPayoutRule(address diamond);

    /// @notice Refuse a Diamond that routes either host to no facet. Call it
    ///         before anything is deployed, so a refused run sends nothing.
    function requireRouted(address diamond) internal view {
        IDiamondLoupe loupe = IDiamondLoupe(diamond);
        if (
            loupe.facetAddress(OfferBookFacet.requireOfferHolder.selector) == address(0)
                || loupe.facetAddress(OfferCancelFacet.refundOfferEscrow.selector) == address(0)
        ) revert PredatesPayoutRule(diamond);
    }
}
