// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibRiskMath} from "./LibRiskMath.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
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
 *             routes the matcher's slice from the lender's vault to
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
        CollateralBelowRequired,  // borrower's range can't cover the lender's pro-rated requirement (post-#164: `picked = max(reqFromLender, B.collateralAmount)` exceeds `B.collateralAmountMax - B.collateralAmountFilled`)
        OfferAccepted,            // either offer already terminal
        WrongOfferType,           // L isn't Lender or B isn't Borrower
        HFTooLow,                 // (depthTieredLtvEnabled off) synthetic HF at matched amount + collateral < 1.5e18
        LtvAboveTier              // (depthTieredLtvEnabled on) synthetic init-LTV at matched amount + collateral > the effective tier cap (or collateral is Tier 0 / no-borrow)
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
    ///         lender's vault and forward it to `matcher`. Caller
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
                VaultFactoryFacet.vaultWithdrawERC20.selector,
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

    // Note: `_effBorrowerAmountMax` was deleted in #183 (Canonical
    // Limit-Order Phase 2). Under the new invariant `amountMax > 0`
    // enforced at create time, storage never holds the legacy GTC
    // sentinel `0`, so the derivation that resolved that case is dead
    // code. Callers read `B.amountMax` directly. See
    // `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md` §5 for
    // the full rationale; the frontend now derives the borrower's max
    // client-side at offer-create time (oracle × tier-LTV) and ships
    // the explicit non-zero value to `OfferCreateFacet`.

    /// @notice Validate a candidate match between two offers and
    ///         compute the concrete (amount, rateBps, reqCollateral)
    ///         the resulting loan would carry. Pure of side effects;
    ///         no state writes. The synthetic init-gate check mirrors
    ///         `LoanFacet._checkInitialLtvAndHf` — `HF >= 1.5e18` while
    ///         `depthTieredLtvEnabled` is off (`MatchError.HFTooLow` on
    ///         fail), the per-tier LTV cap when it's on (`MatchError.LtvAboveTier`)
    ///         — so a bot can filter pairs the binding gate would revert
    ///         without paying for the reverting tx.
    /// @dev    Post-#102, both sides support partial-fill symmetrically.
    ///         Lender remaining = `L.amountMax - L.amountFilled`. Borrower
    ///         remaining = `effBorrowerAmountMax - B.amountFilled` where
    ///         `effBorrowerAmountMax` applies the ADR-0010 §3 fallback:
    ///         when `B.amountMax == 0` (GTC default), derive the ceiling
    ///         from `maxLendingForLtvCap(collateralAmountMax, init-LTV cap)`
    ///         using the SAME effective init-LTV cap that
    ///         `LoanFacet._checkInitialLtvAndHf` consults at admission.
    ///
    ///         The Phase 1 borrower single-fill rule (offer becomes
    ///         `accepted = true` after one match, destroying the unused
    ///         range) is preserved when `partialFillEnabled` is OFF —
    ///         `OfferAcceptFacet._acceptOffer` flips `accepted = true`
    ///         unconditionally in that case, so `previewMatch`'s
    ///         `B.accepted` guard naturally cascade-skips subsequent
    ///         matches. When `partialFillEnabled` is ON, the accept
    ///         flip is deferred to `OfferMatchFacet.matchOffers`' dust-
    ///         close branch, allowing repeated matches to consume the
    ///         borrower's remaining capacity until dust. See
    ///         RangeOffersDesign §17.3 / ADR-0010 for the full design.
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
        // Borrower's effective amountMax — direct storage read post-#183.
        // The GTC derivation `_effBorrowerAmountMax` is deleted; storage
        // always holds an explicit non-zero ceiling (frontend computes
        // `collateralAmountMax × tier-LTV-cap` and ships the value at
        // create-time). See CanonicalLimitOrderPhase2Design §5.
        //
        // The underflow guard below stays load-bearing: `B.amountFilled`
        // accumulates per match, and a third-party caller (script, fork)
        // could in theory create an offer with `amountMax < amountFilled`
        // after an upgrade pause (no path exists today, but the guard
        // costs nothing and forces a clean `AmountNoOverlap` instead of
        // a panic revert).
        uint256 effBorrowerAmountMax = B.amountMax;
        if (effBorrowerAmountMax <= B.amountFilled) {
            r.errorCode = MatchError.AmountNoOverlap;
            return r;
        }
        uint256 borrowerRemaining = effBorrowerAmountMax - B.amountFilled;
        // Range overlap on amount: [max(L.min, B.min), min(lenderRemaining, borrowerRemaining)].
        uint256 lo = L.amount > B.amount ? L.amount : B.amount;
        uint256 hi = lenderRemaining < borrowerRemaining ? lenderRemaining : borrowerRemaining;
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
        uint256 reqFromLender = L.amountMax == 0
            ? L.collateralAmount
            : (L.collateralAmount * r.matchAmount) / L.amountMax;
        // Issue #164 — borrower-side collateral range. Two regimes,
        // chosen by whether `collateralAmountMax` actually widens the
        // borrower's committed range:
        //
        //   (1) Legacy / single-value borrower offer (
        //       `collateralAmountMax == collateralAmount` post auto-
        //       collapse, OR `collateralAmountMax == 0` which is the
        //       pre-#164 storage default if/when a live diamond ever
        //       gets upgraded onto this code without a per-offer
        //       backfill — the same `0 ⇒ floor` fallback that the
        //       lender side uses one line above): preserve the pre-
        //       #164 semantic exactly. The picked / locked collateral
        //       equals the lender's pro-rated requirement; the
        //       borrower's posted overage is refunded by the
        //       OfferMatchFacet excess-refund hook. Single-value
        //       borrowers' UX expectation is "I posted X and the
        //       protocol locks what's actually needed up to X" — that
        //       lock-the-requirement / refund-the-rest behaviour MUST
        //       survive the storage migration bit-for-bit.
        //
        //   (2) Real ranged borrower offer (`collateralAmountMax >
        //       collateralAmount`): clamp the locked amount UP to the
        //       borrower's min so a borrower who committed AT LEAST
        //       X gets at least X locked (better HF cushion, lender
        //       happy). Mirrors how amount works today —
        //       `lo = max(L.amount, B.amount)`. Match fails only when
        //       the clamped value exceeds the borrower's remaining
        //       ceiling.
        uint256 borrowerCollMax = B.collateralAmountMax == 0
            ? B.collateralAmount
            : B.collateralAmountMax;
        bool borrowerRanged = borrowerCollMax > B.collateralAmount;
        uint256 picked;
        if (borrowerRanged) {
            // Range mode — clamp-up.
            uint256 borrowerCeiling =
                borrowerCollMax - B.collateralAmountFilled;
            picked = reqFromLender > B.collateralAmount
                ? reqFromLender
                : B.collateralAmount;
            if (picked > borrowerCeiling) {
                r.errorCode = MatchError.CollateralBelowRequired;
                return r;
            }
        } else {
            // Single-value / legacy mode — pre-#164 semantic exactly.
            // Borrower's posted collateral must cover the lender's
            // pro-rated requirement; the LOCKED amount stays at that
            // requirement and the OfferMatchFacet excess-refund hook
            // returns the overage to the borrower's wallet.
            if (B.collateralAmount < reqFromLender) {
                r.errorCode = MatchError.CollateralBelowRequired;
                return r;
            }
            picked = reqFromLender;
        }
        r.reqCollateral = picked;

        // Synthetic init-gate check at the matched (amount, reqCollateral)
        // — must mirror `LoanFacet._checkInitialLtvAndHf` so a bot's
        // preview never admits a pair the binding gate would revert. Two
        // regimes, switched by `depthTieredLtvEnabled`:
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            // ON: the effective init-LTV cap = min(per-asset loanInitMaxLtvBps,
            // tierMaxInitLtvBps[effectiveTier(collateral)]). A Tier-0 /
            // no-maxLtv collateral ⇒ cap 0 ⇒ no positive amount works.
            uint8 effTier =
                OracleFacet(address(this)).getEffectiveLiquidityTier(L.collateralAsset);
            uint256 maxLtv = s.assetRiskParams[L.collateralAsset].loanInitMaxLtvBps;
            // Phase 5 of AutonomousLtvAndOracleFallback.md — read the
            // autonomous tier-LTV cache (peer-derived + bound-checked,
            // refreshable permissionlessly) instead of the governance
            // setter. Hard-stale cache falls back to per-tier library
            // defaults. Keeps `matchOffers`' synthetic-HF check in sync
            // with `LoanFacet._checkInitialLtvAndHf` — both consult
            // the same effective cap.
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(effTier));
            uint256 cap = maxLtv < tierCap ? maxLtv : tierCap;
            uint256 capFloor = LibRiskMath.minCollateralForLtvCap(
                r.matchAmount,
                L.lendingAsset,
                L.collateralAsset,
                cap
            );
            // `capFloor == type(uint256).max` ⇒ cap is 0 (no borrow) ⇒
            // reject. `capFloor == 0` ⇒ no create-time bound (missing
            // oracle) ⇒ leave it to the runtime gate. Otherwise the
            // matched collateral must meet the floor.
            if (
                capFloor == type(uint256).max
                || (capFloor != 0 && r.reqCollateral < capFloor)
            ) {
                r.errorCode = MatchError.LtvAboveTier;
                return r;
            }
        } else {
            // OFF (the default): HF >= 1.5e18 — reuse the LibRiskMath
            // floor; matched collateral >= floor(matchAmount) ⇒ satisfied.
            uint256 floor = LibRiskMath.minCollateralForLending(
                r.matchAmount,
                L.lendingAsset,
                L.collateralAsset
            );
            if (floor > 0 && r.reqCollateral < floor) {
                r.errorCode = MatchError.HFTooLow;
                return r;
            }
        }

        r.lenderRemainingPostMatch = lenderRemaining - r.matchAmount;
        r.errorCode = MatchError.Ok;
        return r;
    }
}
