// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";

/**
 * @title  RefinanceRecordRollout
 * @notice #2407 — the curated refresh scripts refuse a Diamond that predates the
 *         loan → refinance-request record.
 * @dev    The record is written by `OfferCreateFacet` at request creation, read
 *         by the borrower-action guards in `RepayFacet`, `PrecloseFacet`,
 *         `PartialWithdrawalFacet` and `SwapToRepayPartialFacet`, required by
 *         `RefinanceFacet`'s atomic completion, and mirrored by
 *         `OfferPreviewFacet` / `OfferMatchFacet`. No curated script refreshes
 *         that whole set, and a partial install breaks it in either direction
 *         — a refreshed `RefinanceFacet` with a stale `OfferCreateFacet` refuses
 *         every new request (nothing records it), and a refreshed
 *         `OfferPreviewFacet` with a stale `RefinanceFacet` reports requests as
 *         untakeable that still are. So the change rolls out only through
 *         `DeployDiamond` or `RefreshAllFacetsInPlace`, which install every
 *         facet together. `getRefinanceRequest` is the marker: it is routed
 *         exactly when that rollout has happened.
 */
library RefinanceRecordRollout {
    function assertInstalled(address diamond) internal view {
        require(
            IDiamondLoupe(diamond).facetAddress(RefinanceFacet.getRefinanceRequest.selector)
                != address(0),
            "#2407: this Diamond predates the refinance-request record - roll it out with RefreshAllFacetsInPlace first"
        );
    }
}
