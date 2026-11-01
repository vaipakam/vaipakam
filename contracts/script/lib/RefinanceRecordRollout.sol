// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";

/**
 * @title  RefinanceRecordRollout
 * @notice The curated refresh scripts refuse a Diamond that predates either of
 *         the two refinance changes that span facets they do not carry whole:
 *         the loan → refinance-request record (#2407) and the netted atomic
 *         payoff (#3042).
 * @dev    #2407. The record is written by `OfferCreateFacet` at request
 *         creation, read by the borrower-action guards in `RepayFacet`,
 *         `PrecloseFacet`, `PartialWithdrawalFacet` and
 *         `SwapToRepayPartialFacet`, required by `RefinanceFacet`'s atomic
 *         completion, and mirrored by `OfferPreviewFacet` / `OfferMatchFacet`.
 *         No curated script refreshes that whole set, and a partial install
 *         breaks it in either direction — a refreshed `RefinanceFacet` with a
 *         stale `OfferCreateFacet` refuses every new request (nothing records
 *         it), and a refreshed `OfferPreviewFacet` with a stale
 *         `RefinanceFacet` reports requests as untakeable that still are.
 *         `getRefinanceRequest` is the marker: it is routed exactly when that
 *         rollout has happened.
 *
 *         #3042. The payoff is one behaviour across two facets: the accept's
 *         net-principal delivery (`OfferAcceptFeeFacet`) parks the new
 *         lender's net principal in their vault instead of sending it to the
 *         borrower, and `RefinanceFacet` spends what was parked. `RedeployFacets`
 *         carries only the second and `ReplaceStaleFacets` only the first, so
 *         either one crossing this boundary splits the payoff:
 *           - a parking accept with a pre-#3042 `RefinanceFacet` records the
 *             new loan's principal as delivered while it stays in the new
 *             lender's vault, and pulls the whole payoff from the borrower's
 *             wallet;
 *           - a netting `RefinanceFacet` with a pre-#3042 accept finds nothing
 *             parked and refuses every refinance.
 *         The marker is the retired standalone completion
 *         `refinanceLoan(uint256,uint256)`: #3042 removed it, so a Diamond
 *         that still routes it predates the netting. Both changes roll out only
 *         through `DeployDiamond` or `RefreshAllFacetsInPlace`, which install
 *         every facet together (the latter also sweeps the retired selector).
 */
library RefinanceRecordRollout {
    /// @dev The standalone completion #3042 retired; routed only on a Diamond
    ///      from before the netted payoff. Spelled as a signature because the
    ///      function no longer exists to take a `.selector` from.
    bytes4 internal constant RETIRED_REFINANCE_LOAN =
        bytes4(keccak256("refinanceLoan(uint256,uint256)"));

    function assertInstalled(address diamond) internal view {
        require(
            IDiamondLoupe(diamond).facetAddress(RefinanceFacet.getRefinanceRequest.selector)
                != address(0),
            "#2407: this Diamond predates the refinance-request record - roll it out with RefreshAllFacetsInPlace first"
        );
        require(
            IDiamondLoupe(diamond).facetAddress(RETIRED_REFINANCE_LOAN) == address(0),
            "#3042: this Diamond predates the netted refinance payoff - roll it out with RefreshAllFacetsInPlace first"
        );
    }
}
