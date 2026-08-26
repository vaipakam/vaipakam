// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {VPFIDiscountFacet} from "../facets/VPFIDiscountFacet.sol";

/**
 * @title  LibLenderYieldFeeHost
 * @notice The ONE implementation of the host-routed lender yield-fee resolve
 *         (#1383). Every settlement path that honors the lender's hold + Full
 *         stamps reaches {VPFIDiscountFacet.resolveLenderYieldFeeFor} through
 *         this helper.
 *
 * @dev    Why this is its own library rather than a private helper per facet:
 *         by #1947 the same twelve-line helper had been hand-copied into FIVE
 *         facets (`RepayFacet`, `RepayPeriodicFacet`, `PrecloseFacet`,
 *         `SwapToRepayFacet`, `AutoLifecycleFacet`) and again into
 *         `LibSwapToRepayIntentSettlement`, and #1383's recovery sweep would
 *         have added three more. The early return below is correctness-critical
 *         and is exactly the kind of thing that drifts between copies.
 *
 *         It is NOT primarily a bytecode saving — an `internal` library function
 *         is inlined into each consumer. What it buys is one place where the
 *         routing rule and its short-circuit are stated.
 *
 *         **Why the short-circuit is inlined rather than left to the host.**
 *         {LibVPFIDiscount.resolveLenderYieldFeeFor} repeats the same guard, so
 *         routing an ineligible loan would be correct, just wasteful. The reason
 *         to check here is that it keeps the resolve a strict no-op for every
 *         unstamped / no-consent loan, INCLUDING on a Diamond that does not cut
 *         `VPFIDiscountFacet` at all (the test diamonds). Remove it and those
 *         revert on a path that should never have been entered.
 *
 *         **Why it does NOT live in {LibVPFIDiscount}.** That library is
 *         imported by `VPFIDiscountFacet`; importing the facet back for its
 *         selector would close an import cycle. This library is imported only by
 *         consumers, so the dependency stays one-way.
 *
 *         **Settling lender.** Callers pass the party actually being paid —
 *         `LibERC721.ownerOf(loan.lenderTokenId)`, never the stored
 *         `loan.lender`. Every settlement path attempts a Tier-2 consolidation
 *         first and that consolidation is deliberately *skip-not-block*, so a
 *         call to it is not proof the stored field is fresh. Keying on the stale
 *         address prices the discount off the PREVIOUS lender's hold tier and,
 *         once the peg is set, debits that party's VPFI vault for a reduction
 *         the current holder receives.
 */
library LibLenderYieldFeeHost {
    /**
     * @notice Resolve the lender yield-fee discount for `settlingLender`.
     * @dev    The two returns always satisfy
     *         `lenderExtra + newTreasury == treasuryShare`, on BOTH delivery
     *         paths — the VPFI-payment path returns `(treasuryShare, 0,
     *         deducted)` and the direct-reduction path returns
     *         `(r, treasuryShare - r, 0)`. A caller whose lender share is a
     *         RESIDUAL of the treasury cut (`lenderProceeds = X - treasuryFee`)
     *         therefore needs only `newTreasury`; folding `lenderExtra` in as
     *         well would double-count.
     * @param  loanId           Loan being settled.
     * @param  settlingLender   The party actually being paid — the CURRENT
     *                          position-NFT holder.
     * @param  interestForQuote Interest the treasury cut was taken from, used to
     *                          size the VPFI quote.
     * @param  treasuryShare    The full (undiscounted) treasury share.
     * @return lenderExtra      Lending-asset amount to add to the lender share.
     * @return newTreasury      Treasury share to actually transfer.
     */
    function resolve(
        uint256 loanId,
        address settlingLender,
        uint256 interestForQuote,
        uint256 treasuryShare
    ) internal returns (uint256 lenderExtra, uint256 newTreasury) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (
            treasuryShare == 0 ||
            !LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)
        ) {
            return (0, treasuryShare);
        }
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                loanId,
                settlingLender,
                interestForQuote,
                treasuryShare
            ),
            bytes4(0)
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }
}
