// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";

/**
 * @title LibSaleListing
 * @notice #951 v2 (bind-to-live redesign) — lifecycle teardown for a
 *         lender-position sale listing (`EarlyWithdrawalFacet.createLoanSaleOffer`)
 *         when its underlying loan reaches a TERMINAL state without the sale
 *         completing (full repay, time-based default, HF-liquidation, internal
 *         match). This closes the Codex #959 round-8 P2 finding: a listed loan
 *         that repaid/defaulted left a dangling `loanToSaleOfferId` link, a
 *         still-locked lender position NFT, and an open sale offer that could
 *         never settle (`completeLoanSale` reverts once the loan leaves Active).
 *
 * @dev Invoked via the permissionless `OfferCancelFacet.teardownStaleSaleListing`
 *      entry (anyone — the seller, the keeper, the frontend — may trigger the
 *      cleanup once the loan is terminal; no value moves, mirroring the #195
 *      lazy-clear of expired offers). It is deliberately NOT hooked into the
 *      {LibLifecycle} transition chokepoint: the three facets that drive terminal
 *      transitions (Repay / Defaulted / Risk) all sit within a few hundred bytes
 *      of the EIP-170 ceiling (RiskFacet within ~1 byte), so inlining the
 *      teardown body — or even a cross-facet stub — into the transition path
 *      overflows them. Fund-safety does not depend on the teardown: a stale
 *      listing can never be over-accepted because `LoanFacet.initiateLoan`
 *      already rejects a sale-vehicle accept whose linked loan is not Active. The
 *      teardown is pure hygiene (unlock the lender NFT, drop the dead offer from
 *      the book). Idempotent and a cheap no-op when the loan carries no listing.
 */
library LibSaleListing {
    /// @notice A live sale listing was torn down because its loan exited to a
    ///         terminal state before the sale completed. Indexers surface the
    ///         `saleOfferId` as cancelled off the back of this + `offerCancelled`.
    event LoanSaleListingTornDown(uint256 indexed loanId, uint256 indexed saleOfferId);

    /**
     * @notice Tear down the live sale listing (if any) for a loan that has just
     *         reached a terminal state without a completed sale.
     * @dev No-op when the loan has no listing (`loanToSaleOfferId == 0`) or the
     *      listing's sale offer is already accepted (that path is mid-flight and
     *      settles via `completeLoanSale`, which clears the link itself — this
     *      helper must never disturb an in-flight sale). Otherwise:
     *        1. release the native lock on the lender position NFT (so the
     *           terminal holder regains transfer rights — `_unlock` is itself a
     *           no-op on an already-unlocked token, keeping this idempotent),
     *        2. mark the dangling sale offer cancelled so it drops out of the
     *           open book and can't be accepted against a non-Active loan, and
     *        3. clear both link directions.
     * @param s      Diamond storage pointer.
     * @param loanId The loan that just exited to a terminal state.
     */
    function teardownOnLoanExit(LibVaipakam.Storage storage s, uint256 loanId) internal {
        uint256 saleOfferId = s.loanToSaleOfferId[loanId];
        if (saleOfferId == 0) return; // no live listing — nothing to tear down
        // An accepted-but-not-yet-completed sale is mid-flight; it settles via
        // completeLoanSale (which clears the link). Never disturb it here.
        if (s.offers[saleOfferId].accepted) return;

        LibERC721._unlock(s.loans[loanId].lenderTokenId);

        s.offerCancelled[saleOfferId] = true;
        LibMetricsHooks.onOfferCancelled(saleOfferId);

        delete s.loanToSaleOfferId[loanId];
        delete s.saleOfferToLoanId[saleOfferId];

        emit LoanSaleListingTornDown(loanId, saleOfferId);
    }
}
