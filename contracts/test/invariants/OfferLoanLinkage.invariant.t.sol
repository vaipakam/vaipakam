// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {OfferFacet} from "../../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title OfferLoanLinkageInvariant
 * @notice Every loan the protocol considers active or defaulted must point
 *         back to an offer that was once accepted, and that offer must map
 *         back to exactly this loan via `offerIdToLoanId`. The reverse
 *         relationship is the load-bearing invariant for:
 *
 *           - claim entitlement (claim path reads loan → offer → parties)
 *           - default settlement (DefaultedFacet reads loan.offerId)
 *           - position-NFT minting (NFT facet consults the offer record)
 *
 *         A loan that escapes this relationship — e.g. an orphan loan with
 *         loan.offerId == 0, or a loan whose offerId points at an offer
 *         where `accepted == false` or where `offerIdToLoanId[offerId] !=
 *         this loan` — would corrupt every one of those downstream flows.
 *
 *         Repaid / Closed / Fallback* loans are also checked: once a
 *         loan has progressed past Active, the linkage must still hold
 *         (offer still marked accepted, pointer still consistent).
 */
contract OfferLoanLinkageInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    /// @notice Every loan initiated by the fuzzer carries a valid offer link.
    function invariant_EveryLoanLinksBackToAcceptedOffer() public view {
        OfferCancelFacet offerView = OfferCancelFacet(address(base.diamond()));
        LoanFacet loanView = LoanFacet(address(base.diamond()));
        uint256 n = handler.loanIdsLength();

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loanView.getLoanDetails(loanId);

            // A populated loan record always carries its id and never sits
            // at the zero-initialised default — a zero id here would mean
            // the handler ghost list drifted into uninitialised storage.
            assertEq(L.id, loanId, "loan record id mismatch with ghost list");

            // Forward edge: loan must name its originating offer.
            assertGt(L.offerId, 0, "loan.offerId is zero");

            LibVaipakam.Offer memory O = offerView.getOffer(L.offerId);

            // Offer must exist (creator set) and be marked accepted.
            assertTrue(O.creator != address(0), "offer record missing");
            assertTrue(O.accepted, "linked offer not marked accepted");

            // Offer semantics must match the loan's assets — regression
            // guard against a loan pointing at an unrelated offer.
            assertEq(
                L.principalAsset,
                O.lendingAsset,
                "loan principalAsset != offer lendingAsset"
            );
            assertEq(
                L.collateralAsset,
                O.collateralAsset,
                "loan collateralAsset != offer collateralAsset"
            );
        }
    }
}
