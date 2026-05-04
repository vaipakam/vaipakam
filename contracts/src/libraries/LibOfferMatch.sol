// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibRiskMath} from "./LibRiskMath.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {RiskFacet} from "../facets/RiskFacet.sol";

/**
 * @title LibOfferMatch
 * @notice Shared matching core for Range Orders Phase 1 (see
 *         docs/RangeOffersDesign.md §4 + §5 + §10). PR3 ships the
 *         **preview surface** + the **1% LIF matcher-fee split helpers**
 *         consumed by `OfferFacet._acceptOffer` + the future
 *         `OfferFacet.matchOffers` entry point. The full `executeMatch`
 *         core (which fully refactors `_acceptOffer` into a wrapper) is
 *         a planned follow-up — its scope is large enough that splitting
 *         the work along this seam keeps each PR reviewable.
 *
 *         Today's surface:
 *           - `previewMatch(L, B)` view: validates the match-validity
 *             matrix from §4.1 + computes midpoint terms from §4.2 +
 *             returns a structured `MatchResult` so bots can filter
 *             candidate pairs without submitting reverting txs.
 *           - `splitLifToMatcher` helper: splits a fee amount 99/1 and
 *             routes the matcher's slice from the lender's escrow to
 *             the matcher address. Treasury receives the 99% slice via
 *             the caller's existing path. Used by `_acceptOffer` on the
 *             lender-asset path.
 *           - `matcherShareOf(totalFee)` pure helper: 1% slice math.
 *
 *         No storage; all state reads pass through `LibVaipakam.storageSlot()`.
 */
library LibOfferMatch {
    /// Match-validity error codes returned via `MatchResult.errorCode`.
    /// Kept as enum so the preview API has structured failure semantics
    /// without bloating the revert ABI on the executeMatch path (which
    /// uses typed reverts directly).
    enum MatchError {
        Ok,
        AssetMismatch,            // lending / collateral asset differ
        AssetTypeMismatch,        // assetType / collateralAssetType differ
        DurationMismatch,         // durationDays differ
        AmountNoOverlap,          // [maxMin, minMax] empty
        RateNoOverlap,
        CollateralBelowRequired,  // borrower's posted collateral < lender's required at the matched amount
        OfferAccepted,            // either offer already terminal
        WrongOfferType,           // L isn't Lender or B isn't Borrower
        HFTooLow                  // synthetic HF at matched amount + collateral < 1.5e18
    }

    /// @notice Structured return from `previewMatch`. Bots check
    ///         `errorCode == MatchError.Ok` before submitting `matchOffers`.
    /// @dev    `matchAmount` / `matchRateBps` / `reqCollateral` are
    ///         meaningful only when `errorCode == Ok`. On error they
    ///         carry whatever partial computation completed — bots
    ///         should ignore them.
    struct MatchResult {
        MatchError errorCode;
        uint256 matchAmount;
        uint256 matchRateBps;
        uint256 reqCollateral;
        uint256 lenderRemainingPostMatch;
    }

    /// @notice Asset-continuity check between an existing loan and a
    ///         replacement offer (Preclose's `transferObligationViaOffer`
    ///         + Refinance's `refinanceLoan`). Returns `true` iff the
    ///         offer carries the same lendingAsset, collateralAsset,
    ///         collateralAssetType, and prepayAsset as the loan.
    /// @dev    Returns bool (rather than reverting) so each caller can
    ///         wrap in its own facet-specific revert (`InvalidOfferTerms`
    ///         in Preclose, `InvalidRefinanceOffer` in Refinance) — the
    ///         test suites depend on those typed errors. Single source
    ///         of truth for the per-asset invariants; flow-specific
    ///         amount / duration / collateral-amount checks stay
    ///         inlined per caller (their semantics differ — Preclose
    ///         requires exact principal match, Refinance allows overage).
    function assertAssetContinuity(
        LibVaipakam.Loan storage loan,
        LibVaipakam.Offer storage offer
    ) internal view returns (bool) {
        if (offer.lendingAsset != loan.principalAsset) return false;
        if (offer.collateralAsset != loan.collateralAsset) return false;
        if (offer.collateralAssetType != loan.collateralAssetType) return false;
        if (offer.prepayAsset != loan.prepayAsset) return false;
        return true;
    }

    /// @notice The 1% match-fee BPS slice of any totalFee. Pure.
    /// @dev    Used by both the lender-asset path (immediate at
    ///         `_acceptOffer`) and the VPFI path (deferred to
    ///         settlement via `LibVPFIDiscount.settleBorrowerLifProper`
    ///         / `forfeitBorrowerLif`). Single source of truth so the
    ///         99/1 split semantics never drift between call sites.
    function matcherShareOf(uint256 totalFee) internal view returns (uint256) {
        // Reads governance-tunable BPS from storage so the kickback
        // can be dialed without a contract upgrade. Falls back to
        // LIF_MATCHER_FEE_BPS (100 = 1%) when unset; capped at 50%
        // by the setter (`ConfigFacet.setLifMatcherFeeBps`).
        return (totalFee * LibVaipakam.cfgLifMatcherFeeBps()) / LibVaipakam.BASIS_POINTS;
    }

    /// @notice Pull the matcher's 1% slice of `totalFee` from the
    ///         lender's escrow and forward it to `matcher`. Caller
    ///         is responsible for forwarding the remaining
    ///         `(totalFee - matcherCut)` to treasury through its
    ///         existing path. Returns the matcher's actual slice so
    ///         the caller can subtract it from the treasury total.
    /// @dev    No-op (returns 0) when `totalFee == 0` or
    ///         `matcher == address(0)` — the latter covers legacy loans
    ///         created before `loan.matcher` started being recorded.
    function splitLifToMatcher(
        address asset,
        uint256 totalFee,
        address lender,
        address matcher
    ) internal returns (uint256 matcherCut) {
        if (totalFee == 0 || matcher == address(0)) return 0;
        matcherCut = matcherShareOf(totalFee);
        if (matcherCut == 0) return 0;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                lender,
                asset,
                matcher,
                matcherCut
            ),
            // Reuse the existing TreasuryTransferFailed error selector
            // by re-importing it locally would couple this lib to
            // OfferFacet; instead, encode a generic-revert path via the
            // crossFacetCall helper which surfaces the inner revert
            // reason already.
            bytes4(0)
        );
    }

    /// @notice Pure midpoint helper: `(a + b) / 2`. Both args must be
    ///         > 0 in normal use; caller is responsible for guarding
    ///         `a + b` overflow (BPS / fee-amount math always fits).
    function midpoint(uint256 a, uint256 b) internal pure returns (uint256) {
        unchecked { return (a + b) / 2; }
    }

    /// @notice Validate a candidate match between two offers and
    ///         compute the concrete (amount, rateBps, reqCollateral)
    ///         the resulting loan would carry. Pure of side effects;
    ///         no state writes. Synthetic HF check uses `LibRiskMath`
    ///         so bots can filter HF-failing pairs without paying for
    ///         a reverting tx.
    /// @dev    Borrower-offer is single-fill in Phase 1; this preview
    ///         enforces that the borrower's `amountFilled == 0`. For
    ///         lender-offer (which can be partial-filled), uses
    ///         `amountMax - amountFilled` as remaining capacity. See
    ///         design §4.1 for the validity matrix and §10.3 for the
    ///         partial-fill semantics.
    function previewMatch(uint256 lenderOfferId, uint256 borrowerOfferId)
        internal
        view
        returns (MatchResult memory r)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage L = s.offers[lenderOfferId];
        LibVaipakam.Offer storage B = s.offers[borrowerOfferId];

        // Both offers must exist and be Lender + Borrower respectively.
        if (
            L.creator == address(0)
            || B.creator == address(0)
            || L.offerType != LibVaipakam.OfferType.Lender
            || B.offerType != LibVaipakam.OfferType.Borrower
        ) {
            r.errorCode = MatchError.WrongOfferType;
            return r;
        }

        if (L.accepted || B.accepted) {
            r.errorCode = MatchError.OfferAccepted;
            return r;
        }

        // Asset continuity: both legs must reference the same contracts
        // and asset types so the resulting loan struct's fields are
        // unambiguous.
        if (
            L.lendingAsset != B.lendingAsset
            || L.collateralAsset != B.collateralAsset
        ) {
            r.errorCode = MatchError.AssetMismatch;
            return r;
        }
        if (
            L.assetType != B.assetType
            || L.collateralAssetType != B.collateralAssetType
        ) {
            r.errorCode = MatchError.AssetTypeMismatch;
            return r;
        }
        if (L.durationDays != B.durationDays) {
            r.errorCode = MatchError.DurationMismatch;
            return r;
        }

        // Lender's remaining capacity = amountMax - amountFilled.
        uint256 lenderRemaining = L.amountMax - L.amountFilled;
        // Range overlap on amount: [max(L.min, B.min), min(lenderRemaining, B.max)].
        uint256 lo = L.amount > B.amount ? L.amount : B.amount;
        uint256 hi = lenderRemaining < B.amountMax ? lenderRemaining : B.amountMax;
        if (lo > hi) {
            r.errorCode = MatchError.AmountNoOverlap;
            return r;
        }
        r.matchAmount = midpoint(lo, hi);

        // Range overlap on rate.
        uint256 rateLo = L.interestRateBps > B.interestRateBps
            ? L.interestRateBps
            : B.interestRateBps;
        uint256 rateHi = L.interestRateBpsMax < B.interestRateBpsMax
            ? L.interestRateBpsMax
            : B.interestRateBpsMax;
        if (rateLo > rateHi) {
            r.errorCode = MatchError.RateNoOverlap;
            return r;
        }
        r.matchRateBps = midpoint(rateLo, rateHi);

        // Pro-rated collateral required for THIS match (§10.4).
        // Lender's `collateralAmount` is the requirement at amountMax;
        // pro-rate against the matched amount.
        r.reqCollateral = L.amountMax == 0
            ? L.collateralAmount
            : (L.collateralAmount * r.matchAmount) / L.amountMax;
        // Borrower's posted collateral must cover the requirement.
        if (B.collateralAmount < r.reqCollateral) {
            r.errorCode = MatchError.CollateralBelowRequired;
            return r;
        }

        // Synthetic HF check: at the matched (amount, reqCollateral),
        // does HF >= 1.5e18 hold? Reuse the LibRiskMath floor logic —
        // if matched collateral >= floor(matchAmount), HF is satisfied.
        uint256 floor = LibRiskMath.minCollateralForLending(
            r.matchAmount,
            L.lendingAsset,
            L.collateralAsset
        );
        if (floor > 0 && r.reqCollateral < floor) {
            r.errorCode = MatchError.HFTooLow;
            return r;
        }

        r.lenderRemainingPostMatch = lenderRemaining - r.matchAmount;
        r.errorCode = MatchError.Ok;
        return r;
    }
}
