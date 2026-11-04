// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibLoanClock} from "./LibLoanClock.sol";
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
    /// @notice #1503 item 4 — units of slack added to the projected seller cost
    ///         to absorb integer truncation between the two endpoint
    ///         evaluations. Derived in {projectSellerBounds}: the shortfall leg
    ///         is a difference of separately truncated figures, so it can exceed
    ///         its own endpoint values by at most two units at an interior
    ///         second. Slack LOWERS the recorded floor, which is the direction
    ///         that cannot refuse a legitimate fill.
    uint256 internal constant TRUNCATION_SLACK = 2;

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
        // #1503 item 4 — bounds die with the listing they describe.
        clearSellerBounds(s, loanId);

        emit LoanSaleListingTornDown(loanId, saleOfferId);
    }
    /// @notice #1503 item 4 — record the seller's two economic bounds on a new
    ///         sale listing, and the flag that says they exist.
    ///
    /// @dev    Kept in this library rather than inlined into
    ///         {EarlyWithdrawalFacet} because the DIRECT route needs the same
    ///         projection when item 6 lands, and that facet is separate since
    ///         #1780 — inlining here would guarantee the two routes diverge on
    ///         the arithmetic, which is the defect #1659 already had to repair
    ///         once.
    ///
    ///         (Size is NOT the reason, though it was the first one that came
    ///         to mind: the "thirty bytes of headroom" figure belongs to the
    ///         facet BEFORE #1780 split it, and is what motivated the split.
    ///         Measured after, it carries about 5.2 KB free, so this would fit.
    ///         Stated because a wrong justification in a comment outlives the
    ///         decision it justifies.)
    ///
    ///         The two bounds have deliberately different shapes, and the
    ///         asymmetry is the design rather than an inconsistency:
    ///
    ///         The FLOOR is a worst case projected forward. Accrued interest
    ///         grows across the listing window, so a floor at the figure the
    ///         seller saw would make their own listing unfillable within
    ///         minutes. It is the settlement evaluated at BOTH ENDS of the
    ///         window, taking whichever is worse for the seller, plus slack for
    ///         integer truncation — see {projectSellerBounds}, which derives
    ///         both. Not the expiry alone: the two legs of the cost move in
    ///         opposite directions, so an above-rate listing is costliest to
    ///         fill IMMEDIATELY. Either way the whole window fits inside the
    ///         bound — "fill any time before this expires and you receive at
    ///         least X" — and that is only computable because the expiry is
    ///         mandatory and finite.
    ///
    ///         The CEILING is a snapshot taken now. `heldForLender` does not
    ///         grow with time; it grows only when a settlement parks more into
    ///         it, which is exactly the drift being refused, so the value at
    ///         listing IS the bound.
    ///
    ///         What each catches is not the same, and neither is redundant: a
    ///         park enlarges the held balance (the ceiling), and a principal
    ///         change moves the seller's net while parking nothing (the floor).
    /// @param s          The Diamond storage slot.
    /// @param loanId     The loan being listed.
    /// @param saleRateBps The listing's own rate — fixed now, so the shortfall
    ///                    leg of the worst case is knowable at listing.
    /// @param expiresAt  The listing's mandatory finite expiry.
    function recordSellerBounds(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 saleRateBps,
        uint256 expiresAt
    ) internal {
        (uint256 minSellerNet, uint256 maxHeld) =
            projectSellerBounds(s, loanId, saleRateBps, expiresAt);
        s.saleListingMinSellerNet[loanId] = minSellerNet;
        s.saleListingMaxHeldTransfer[loanId] = maxHeld;
        s.saleListingBoundsRecorded[loanId] = true;
        s.saleListingBoundsExpiry[loanId] = expiresAt;
    }

    /// @notice #1503 item 4 — the two bounds a listing with these terms would
    ///         record, without recording them.
    /// @dev    Split out of {recordSellerBounds} so the quote a seller is shown
    ///         and the bound they are held to are ONE computation rather than
    ///         two that agree today. `RiskPreviewFacet.quoteSellerBounds` is the
    ///         external read; every claim about the quote not drifting from the
    ///         rule rests on this being the only place the arithmetic lives.
    ///
    ///         Nothing is written, so this is safe to call before a listing
    ///         exists — which is the only moment the quote is useful, since the
    ///         seller is still deciding.
    /// @return minSellerNet The floor: the least the seller receives if the
    ///                      listing fills at any point before `expiresAt`.
    /// @return maxHeld      The ceiling: `heldForLender` as it stands now.
    function projectSellerBounds(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 saleRateBps,
        uint256 expiresAt
    ) internal view returns (uint256 minSellerNet, uint256 maxHeld) {
        uint256 principal = s.loans[loanId].principal;
        // BOTH ends of the window (Codex #1812 P1). Since #1209 the cost is the
        // rate shortfall alone, owed over the REMAINING term, so it shrinks as
        // the listing stands and peaks at the start; both ends are still read so
        // the bound does not rest on that monotonicity.
        //
        // The shortfall is a difference of two SEPARATELY TRUNCATED interest
        // figures, `trunc(A) - trunc(B)`, which is not monotonic even though
        // `A - B` is: an interior second can cost one unit more than either
        // endpoint (Codex #1812 round-3 P2). With `g = A - B` decreasing,
        // `f(t) <= g(t) + 1 <= g(start) + 1 <= f(start) + 2`, so two units of
        // slack cover every interior second. The slack lowers the floor, so the
        // bound never rejects a fill the seller's own projection allowed; it
        // costs at most two base units of the lending asset.
        uint256 costAtExpiry = worstCaseSellerCost(s, loanId, saleRateBps, expiresAt);
        uint256 costNow = worstCaseSellerCost(s, loanId, saleRateBps, block.timestamp);
        uint256 cost =
            (costAtExpiry > costNow ? costAtExpiry : costNow) + TRUNCATION_SLACK;
        // The buyer's escrowed proceeds are bound to the live principal by the
        // accept-time term bind, so the seller's net is principal minus cost.
        // A cost at or above principal is refused at completion by the existing
        // `RateShortfallTooHigh` guard; the floor simply records zero there
        // rather than underflowing.
        minSellerNet = principal > cost ? principal - cost : 0;
        maxHeld = s.heldForLender[loanId];
    }

    /// @notice #1503 item 4 — what a sale would cost the exiting lender if it
    ///         filled at `at`, using the settlement arithmetic both sale routes
    ///         apply.
    /// @dev    #1209 — the RATE SHORTFALL only: the buyer's higher rate over the
    ///         remaining term. The seller no longer forfeits the interest they
    ///         earned; it becomes a seller claim on the loan
    ///         ({LibInterestLedger.recordSale}), so it is not a cost of the sale.
    function worstCaseSellerCost(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 saleRateBps,
        uint256 at
    ) internal view returns (uint256) {
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #668 / #935 — the remaining term runs to the pause-moved end.
        uint256 remainingSecs = LibLoanClock.remainingInterestSeconds(loan, at);
        uint256 denom = LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS;
        uint256 originalRemaining =
            (loan.principal * loan.interestRateBps * remainingSecs) / denom;
        uint256 saleRemaining = (loan.principal * saleRateBps * remainingSecs) / denom;
        return saleRemaining > originalRemaining ? saleRemaining - originalRemaining : 0;
    }

    /// @notice #1503 item 4 — clear the bounds with the listing they belong to.
    /// @dev    Called wherever `loanToSaleOfferId` is cleared. Leaving them
    ///         behind would apply one listing's bounds to the next.
    function clearSellerBounds(LibVaipakam.Storage storage s, uint256 loanId) internal {
        delete s.saleListingMinSellerNet[loanId];
        delete s.saleListingMaxHeldTransfer[loanId];
        delete s.saleListingBoundsRecorded[loanId];
        delete s.saleListingBoundsExpiry[loanId];
    }
}
