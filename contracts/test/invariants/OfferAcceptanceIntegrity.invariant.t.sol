// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {OfferFacet} from "../../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title OfferAcceptanceIntegrityInvariant
 * @notice Every initiated loan traces back to exactly one accepted offer,
 *         and no offer backs two loans. Three properties keep the offer
 *         ↔ loan lattice honest:
 *
 *           1. For every tracked loanId, the loan's `offerId` is non-zero
 *              — a zero offerId means the loan was minted without an
 *              accepted offer, which the code flow should never allow.
 *           2. The offer pointed to by `loan.offerId` exists and carries
 *              `accepted == true`. A non-accepted backing offer means the
 *              acceptance bit was flipped off after loan creation, which
 *              no code path is permitted to do.
 *           3. Two loans never share the same `offerId`. The mapping is
 *              1-to-1 by construction (`offerIdToLoanId[offerId] =
 *              loanId` in LoanFacet.initiateLoan), but we assert the
 *              observable side so a regression that permits double-accept
 *              shows up here.
 *
 *         These are the "can't duplicate money" structural guarantees of
 *         the offer book — a violation would let a lender's single posted
 *         offer collateralize two different loans, doubling the risk they
 *         took on.
 */
contract OfferAcceptanceIntegrityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    // Used by invariant_UniqueOfferPerLoan to run the uniqueness check in
    // O(n) instead of O(n^2). On first observation of an offerId we latch
    // the loanId that claims it; any later observation must be the same
    // loanId, else two loans share a backing offer.
    mapping(uint256 => uint256) internal offerIdClaimedBy;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_EveryLoanHasAcceptedOffer() public view {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));
        OfferFacet offers = OfferFacet(address(base.diamond()));

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loans.getLoanDetails(loanId);

            assertGt(L.offerId, 0, "loan.offerId is zero: minted without an offer");

            LibVaipakam.Offer memory O = offers.getOffer(L.offerId);
            assertTrue(O.accepted, "backing offer not marked accepted");
            assertTrue(
                O.creator != address(0),
                "backing offer has a zero creator: offer vanished after loan creation"
            );
        }
    }

    /// @notice No two loans share the same backing offerId. Runs in O(n)
    ///         by latching the first loanId observed per offerId in the
    ///         `offerIdClaimedBy` mapping and failing on any mismatch.
    function invariant_UniqueOfferPerLoan() public {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            uint256 offerId = loans.getLoanDetails(loanId).offerId;
            uint256 priorClaimant = offerIdClaimedBy[offerId];
            if (priorClaimant == 0) {
                offerIdClaimedBy[offerId] = loanId;
            } else {
                assertEq(
                    priorClaimant,
                    loanId,
                    "two loans share the same offerId: offer was accepted twice"
                );
            }
        }
    }
}
