// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {LibFacet} from "./LibFacet.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";

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

    // NOTE (Codex #1505 r2): the CANONICAL `OfferCanceled` companion event for
    // a teardown is emitted by the facet entry (`OfferCancelFacet.
    // teardownStaleSaleListing`), where the event is already declared — both
    // teardown paths flow through it, and a library re-declaration would
    // duplicate the event entry in the facet's exported ABI.

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

        _unwind(s, loanId, saleOfferId);
    }

    /**
     * @notice Tear down a live listing whose MANDATORY expiry has passed while
     *         its loan is still live (design item 1 + the borrower action
     *         window). The caller (OfferCancelFacet.teardownStaleSaleListing)
     *         has already verified the loan is Active/FallbackPending, the
     *         sale offer is unaccepted, and `isOfferExpired` is true.
     * @dev Beyond the shared unwind, stamps the per-loan RELIST COOLDOWN:
     *      the listing just released the borrower's partial-repay and
     *      collateral-withdrawal holds, and without a cooldown the seller (or
     *      their keeper) could immediately relist and front-run the borrower's
     *      unblocked transaction — chaining bounded listings back into the
     *      indefinite freeze the mandatory expiry exists to remove.
     * @param s      Diamond storage pointer.
     * @param loanId The live loan whose expired listing is being cleared.
     */
    function teardownExpired(LibVaipakam.Storage storage s, uint256 loanId) internal {
        uint256 saleOfferId = s.loanToSaleOfferId[loanId];
        s.saleRelistCooldownUntil[loanId] = uint64(
            block.timestamp + LibVaipakam.SALE_RELIST_COOLDOWN_SECONDS
        );
        _unwind(s, loanId, saleOfferId);
    }

    /// @dev Shared unwind: release the lender-NFT native lock, cancel the
    ///      vehicle so it drops off the open book, clear both link directions
    ///      (which re-opens the borrower's partial-repay / collateral-
    ///      withdrawal paths — their guards key on `loanToSaleOfferId`).
    ///      Moves NO value: the sale vehicle escrows nothing at creation
    ///      (the `saleVehicleCreate` skip in OfferCreateFacet), which is what
    ///      makes the pause-exempt teardown entry (item 14) safe.
    function _unwind(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 saleOfferId
    ) private {
        LibERC721._unlock(s.loans[loanId].lenderTokenId);

        s.offerCancelled[saleOfferId] = true;
        LibMetricsHooks.onOfferCancelled(saleOfferId);

        // Codex #1505 r1 P2 — mirror `cancelOffer`'s creator-position-NFT
        // cleanup. The vehicle minted an offer-position NFT at creation
        // (`_createOfferFinish` runs for sale vehicles too), and
        // `MetricsFacet.getUserPositionOffers{Paginated}`'s open-offer filter
        // relies ENTIRELY on the `offerIdByPositionTokenId` reverse map —
        // leaving it in place keeps the cancelled vehicle listed as an open
        // position until a second, redundant `cancelOffer` transaction.
        // Burning is pause-safe (`burnNFT` carries no `whenNotPaused`; it is
        // gated on `msg.sender == address(this)`, which this cross-facet hop
        // satisfies), so the item-14 pause-exempt teardown path keeps working.
        uint256 vehiclePositionTokenId = s.offers[saleOfferId].positionTokenId;
        if (vehiclePositionTokenId != 0) {
            delete s.offerIdByPositionTokenId[vehiclePositionTokenId];
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.burnNFT.selector,
                    vehiclePositionTokenId
                ),
                bytes4(0)
            );
        }

        delete s.loanToSaleOfferId[loanId];
        delete s.saleOfferToLoanId[saleOfferId];

        emit LoanSaleListingTornDown(loanId, saleOfferId);
    }
}
