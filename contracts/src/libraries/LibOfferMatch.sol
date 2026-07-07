// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibRiskMath} from "./LibRiskMath.sol";
import {LibAutoRefinanceCheck} from "./LibAutoRefinanceCheck.sol";
import {LibAuth} from "./LibAuth.sol";
import {LibPausable} from "./LibPausable.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

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
        LtvAboveTier,             // (depthTieredLtvEnabled on) synthetic init-LTV at matched amount + collateral > the effective tier cap (or collateral is Tier 0 / no-borrow)
        SelfTrade,                // #194 — both offers carry the same `creator`. The actual revert lives in `_acceptOffer` (`SelfTradeForbidden(party)`); this variant lets bots short-circuit at preview time.
        OfferExpired,             // #195 — either offer's GTT deadline (`expiresAt != 0 && block.timestamp >= expiresAt`) has lapsed. The actual revert lives in `_acceptOffer` (`OfferExpired(offerId, expiresAt)`); this variant lets matching bots short-circuit at preview time. Either side can carry the lapse — both lender and borrower offers are GTT-eligible.
        AonRequiresFullFill,      // #125 — either offer carries `fillMode = Aon` but the would-be matchAmount isn't its full single-shot fill (`offer.amount`), or the offer already has a non-zero `amountFilled`. AON offers admit exactly one fill, sized to the AON-side's `amount`; any divergence aborts. Create-time invariant `amount == amountMax` keeps the "AON-required fill size" unambiguous.
        RefinanceTagged,          // #576/#595 — a refinance-tagged offer that is NOT an admissible AON carry-over match: a lender-tagged offer, or a borrower carry-over offer whose target fails the exhaustive admission mirror (`LibAutoRefinanceCheck.matchAdmissible` — stale target, transferred NFT, gated caps/kill-switch, live intent, diverged retag key, etc.). `matchOffers` reverts `RefinanceTaggedOfferNotMatchable`. Lets bots skip the pair at preview time.
        RefinanceCarryOverCollateralShortfall, // #595 — an admitted carry-over match where the lender's pro-rated collateral requirement exceeds the carried (pinned) amount; carry-over pledges no fresh collateral to top it up.
        SaleVehicleTagged,        // #951 (Codex #959) — the borrower offer is a lender-sale vehicle (linked via `saleOfferToLoanId`). It is fillable ONLY through `acceptOffer` (which auto-completes the linked sale); `matchOffers` reverts `SaleVehicleNotMatchable`. Lets bots skip the pair at preview time.
        OffsetVehicleTagged       // #1001 (S3, Codex #1070 r4) — the LENDER offer is a linked Preclose Option-3 offset vehicle (`offsetOfferToLoanId`). It settles ONLY through `acceptOffer` → `completeOffsetInternal`; `matchOffers` reverts `OffsetVehicleNotMatchable`. Appended LAST to keep every prior ordinal ABI-stable. Lets bots skip the pair at preview time.
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

    /// @notice #625 WI-2b — intent-fill preview failure codes. Each mirrors,
    ///         1:1 and IN THE SAME ORDER, a revert `OfferMatchFacet.matchIntent`
    ///         raises BEFORE the shared match core runs, so an off-chain solver
    ///         learns the exact reason a fill would fail without spending gas on
    ///         a reverting tx. `Ok` means every intent-level guard passed and
    ///         the verdict moves to `MatchResult.errorCode` (+ the facet's
    ///         risk-access block). The order is load-bearing: `previewIntent`
    ///         returns the FIRST failing code, exactly as `matchIntent` reverts
    ///         on its first failing guard — the agreement test pins this.
    enum IntentError {
        Ok,
        Paused,                  // diamond globally paused (whenNotPaused)
        Sanctioned,              // solver or lender flagged by the sanctions oracle
        MatcherDisabled,         // partialFillEnabled OFF  → FunctionDisabled(3)
        IntentDisabled,          // lenderIntentEnabled OFF → FunctionDisabled(4)
        AggregatorPaused,        // aggregator-adapter intent frozen (#633)
        Inactive,                // LenderIntentInactive
        VpfiLendingUnsupported,  // LenderIntentVpfiLendingUnsupported
        KeeperUnauthorized,      // requiresKeeperAuth + this solver not delegated
        BelowMinFill,            // LenderIntentFillBelowMin
        ExposureExceeded,        // LenderIntentExposureExceeded
        DurationTooLong,         // LenderIntentDurationTooLong
        FullTermRequired,        // LenderIntentFullTermRequired
        PartialRepayNotAllowed,  // LenderIntentPartialRepayNotAllowed
        CollateralUnresolvable,  // LenderIntentCollateralUnresolvable
        CapitalInsufficient,     // funded capital < fillAmount (IntentCapitalInsufficient)
        // ── #747 Codex r1: the slice the fill MATERIALIZES (createSignedOfferVault)
        //    can itself trip create-time validators a controlled slice still
        //    reaches; mirror them so Ok can't precede a guaranteed materialize
        //    revert (OfferCreateFacet). ──
        SliceDurationAboveCap,   // slice term > cfgMaxOfferDurationDays (OfferDurationExceedsCap)
        SlicePausedAsset,        // either leg paused at materialize (requireAssetNotPaused)
        SliceCollateralBelowFloor, // range-mode + both-liquid: reqColl < minCollateralForLending floor (MinCollateralBelowFloor)
        SliceMultiYearTerm,      // slice term > 365d: the None-cadence slice can't meet the mandatory >=Annual floor (CadenceNotAllowed)
        // ── #747 Codex r1: after the match core + risk gate, the live fill enters
        //    acceptOfferInternal(borrower) with the slice as acceptor; an
        //    accept-time gate can still reject (set by the facet wrapper). ──
        AcceptGateBlocked,       // borrower sanctioned / asset paused / borrower consent missing
        // #951 v2 (Codex #959 bind-to-live, round-8 P2/P3 preview parity) — the
        // counterparty (borrower) offer is a lender-sale vehicle (linked via
        // `saleOfferToLoanId`). `_executeMatch` reverts `SaleVehicleNotMatchable`
        // on it, so `matchIntent` reverts too; previewIntent must mirror that
        // rather than falsely report Ok. APPENDED — prior ordinals stay stable.
        SaleVehicleTagged
    }

    /// @notice Structured outcome of `RiskAccessFacet.previewIntent`. `ok` is
    ///         true iff EVERY layer cleared: `intentError == Ok` AND
    ///         `matchError == Ok` AND `riskBlock == 0`. The numeric figures
    ///         mirror what the on-chain fill would lock, so a solver can size a
    ///         fill from a single call.
    /// @dev    `matchError` is `Ok` and the figures are zero when an
    ///         intent-level guard already failed (the match core was never
    ///         reached). `riskBlock` is layered in by the facet wrapper (this
    ///         library has no access to the risk-access actor resolver).
    struct IntentPreviewResult {
        bool ok;
        IntentError intentError;  // intent-level guard verdict (this library)
        MatchError matchError;    // shared match-core verdict (Ok if not reached)
        uint8 riskBlock;          // #671 risk-access gate code (facet-filled; 0 = clear)
        uint256 matchAmount;      // principal the fill would draw (== fillAmount on Ok)
        uint256 matchRateBps;     // midpoint rate the resulting loan would carry
        uint256 reqCollateral;    // collateral the borrower must post
        uint256 availableCapital; // un-lent funded capital this intent can still deploy
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
        // Bot preview + the on-chain `matchOffers` path impose NO borrower
        // collateral floor — two on-chain offers each accepted their own
        // single-value / ranged collateral semantics at create time.
        return previewMatch(lenderOfferId, borrowerOfferId, 0);
    }

    /// @notice `previewMatch` with an explicit borrower collateral FLOOR.
    /// @dev    `borrowerCollFloor` is non-zero ONLY for a #396 signed-BORROWER
    ///         slice: it carries the signer's posted (constant-ratio) collateral
    ///         for the fill, so the single-value branch clamps the locked
    ///         amount UP to it AND the HF/LTV synthetic gate runs on the floored
    ///         value — a match that's safe at the signed pledge is no longer
    ///         rejected just because the matched lender's bare requirement is
    ///         lower (Codex #616 round-3 P2). `0` preserves the pre-#616
    ///         refund-the-overage / requirement-locked semantic byte-for-byte.
    function previewMatch(
        uint256 lenderOfferId,
        uint256 borrowerOfferId,
        uint256 borrowerCollFloor
    )
        internal
        view
        returns (MatchResult memory r)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #951 (Codex #959 round-4) — a lender-sale vehicle is a borrower offer
        // linked via `saleOfferToLoanId`. `matchOffers` reverts
        // `SaleVehicleNotMatchable` on it (D3), so preview MUST mirror that here
        // or a bot would see an `Ok` verdict for a pair that always reverts on
        // submit. Checked on the stored id (unavailable in `_previewMatchCore`,
        // which sees only offer VALUES); the #625 intent path never targets a
        // sale vehicle and is already `_executeMatch`-guarded.
        if (s.saleOfferToLoanId[borrowerOfferId] != 0) {
            r.errorCode = MatchError.SaleVehicleTagged;
            return r;
        }
        // #1001 (S3, Codex #1070 r4) — the LENDER offer being a linked offset
        // vehicle likewise always reverts `OffsetVehicleNotMatchable` on submit;
        // mirror it here so a bot doesn't see an `Ok` for a pair that can't match.
        if (s.offsetOfferToLoanId[lenderOfferId] != 0) {
            r.errorCode = MatchError.OffsetVehicleTagged;
            return r;
        }
        // Delegate to the struct-based core so the identical match-admission
        // mirror serves both stored-offer matches and a synthesized #625
        // auto-lend intent slice — the latter has no stored lender offer to
        // pass an id for (it is materialised only inside the state-changing
        // `matchIntent`), so `RiskAccessFacet.previewIntent` builds the slice
        // in memory and previews it through this same core.
        return _previewMatchCore(
            s.offers[lenderOfferId], s.offers[borrowerOfferId], s, borrowerCollFloor
        );
    }

    /// @notice Struct-based core of `previewMatch` — runs the full
    ///         match-admission mirror on offer VALUES instead of stored ids.
    /// @dev    The lender leg is `memory` so a not-yet-stored intent slice can
    ///         be previewed through the SAME predicates the on-chain fill runs;
    ///         the borrower leg stays `storage` because a #625 intent fill
    ///         always targets a stored borrower offer and the
    ///         refinance-carryover (`matchAdmissible`) + expiry helpers it
    ///         feeds take a storage ref. An `Offer memory` param is a single
    ///         memory pointer (not a 40-field stack spill), so this carries no
    ///         viaIR stack cost. `previewMatch` loads both stored offers and
    ///         delegates here — behaviour is byte-identical for the id path.
    /// @param  L Lender-side offer values (a stored lender offer copied to
    ///         memory, or a synthesized intent slice).
    /// @param  B Borrower-side stored offer.
    /// @param  s Diamond storage pointer (refinance-target + risk-param reads).
    /// @param  borrowerCollFloor See the id-based overload's dev note above.
    function _previewMatchCore(
        LibVaipakam.Offer memory L,
        LibVaipakam.Offer storage B,
        LibVaipakam.Storage storage s,
        uint256 borrowerCollFloor
    )
        internal
        view
        returns (MatchResult memory r)
    {
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

        // #595 — carry-over-aware matched refinance. A refinance-tagged BORROWER
        // offer is admissible ONLY as an AON carry-over match whose target
        // passes the exhaustive admission mirror of
        // `RefinanceFacet._refinanceLoanLogic` (see
        // `LibAutoRefinanceCheck.matchAdmissible`). This is the source of truth
        // shared with the on-chain `matchOffers` guard, so preview can't admit a
        // pair the atomic retag would reject (no bot false positives) and an AON
        // single full fill always reaches the dust-close retag hook in the same
        // tx (no uncollateralized window — design §2/§3). A LENDER offer is never
        // refinance-tagged; any non-admissible tagged offer → `RefinanceTagged`.
        bool borrowerCarryOver;
        if (L.refinanceTargetLoanId != 0) {
            r.errorCode = MatchError.RefinanceTagged;
            return r;
        }
        if (B.refinanceTargetLoanId != 0) {
            if (
                !LibAutoRefinanceCheck.matchAdmissible(
                    s, B.refinanceTargetLoanId, B
                )
            ) {
                r.errorCode = MatchError.RefinanceTagged;
                return r;
            }
            // #595 round-2 — for NFT carry-over collateral, the asset-continuity
            // check below only compares the collection address + asset type, but
            // `LoanFacet` copies the BORROWER offer's carried token into the new
            // loan. Require the lender offer to demand the SAME token identity
            // (tokenId + quantity), else a lender wanting token A could be
            // matched to a refinance carrying token B from the same collection,
            // delivering different collateral than the lender's offer specified.
            if (B.collateralAssetType != LibVaipakam.AssetType.ERC20) {
                if (
                    L.collateralTokenId != B.collateralTokenId ||
                    L.collateralQuantity != B.collateralQuantity
                ) {
                    r.errorCode = MatchError.AssetMismatch;
                    return r;
                }
            }
            borrowerCarryOver = true;
        }

        // #195 — GTT lazy-enforcement on the match path. Either side's
        // lapsed deadline kills the match — both lender and borrower
        // can carry an `expiresAt`. Routes through the shared
        // `isOfferExpired` predicate so the GTC short-circuit
        // (`expiresAt == 0`) is co-located with every other consumer.
        // Sits BEFORE the SelfTrade check because expiry is a more
        // fundamental terminal — an expired offer that also happens
        // to be self-trade is still primarily expired, not a
        // racing self-trade attempt; the indexer-facing classifier
        // should reflect that.
        // L may be a memory slice (no storage ref for `isOfferExpired`), so
        // inline the GTC-sentinel expiry check on it; B stays a storage read.
        bool lExpired =
            L.expiresAt != 0 && block.timestamp >= uint256(L.expiresAt);
        if (lExpired || LibVaipakam.isOfferExpired(B)) {
            r.errorCode = MatchError.OfferExpired;
            return r;
        }

        // #194 — self-trade short-circuit. Matching two offers from the
        // same creator would land both lender and borrower on a single
        // address; `_acceptOffer` reverts `SelfTradeForbidden(party)`
        // when that happens (the load-bearing gate). Surfacing it here
        // as a typed `MatchError` saves bots an `acceptOfferInternal`
        // submission + revert + gas burn for an obviously-bad pair.
        if (L.creator == B.creator) {
            r.errorCode = MatchError.SelfTrade;
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
        if (borrowerCarryOver) {
            // §3.2 — a carry-over refinance is AON single-full-fill: force the
            // matched amount to the borrower's full `amount` (the midpoint could
            // exceed it against an open lender range and trip AonRequiresFullFill,
            // blocking a lender from staying partially open). KEEP every
            // lender-side bound: `lo = max(L.amount, B.amount)` and
            // `hi = min(lenderRemaining, borrowerRemaining)`, so requiring
            // `lo <= B.amount <= hi` rejects exactly the cases where B.amount is
            // below the lender's min fill (`L.amount > B.amount`) or above the
            // lender's remaining capacity — only the midpoint *selection* is
            // bypassed, never the legal window. The lender AON gate below then
            // correctly checks `B.amount == L.amount` for a lender-AON offer.
            if (B.amount < lo || B.amount > hi) {
                r.errorCode = MatchError.AmountNoOverlap;
                return r;
            }
            r.matchAmount = B.amount;
        } else {
            r.matchAmount = midpoint(lo, hi);
        }

        // #125 — AON enforcement. An AON offer admits exactly one fill,
        // sized to its full `amount`. The create-time invariant
        // `amount == amountMax` (enforced in `OfferCreateFacet`'s
        // `_writeOfferPrincipalFields`) guarantees the AON-required
        // fill size is `offer.amount` unambiguously. Two conditions
        // must hold per AON side:
        //   (1) the would-be matchAmount equals the AON side's amount,
        //       i.e. the overlap midpoint coincides with the AON-
        //       required full fill;
        //   (2) `amountFilled == 0` — no prior partial fill has
        //       accumulated. Defensive: AON should naturally never
        //       admit a prior fill (it reverts every partial attempt),
        //       so this check is a belt-and-suspenders against any
        //       future code path that bypasses the gate.
        // Both lender + borrower sides are AON-eligible; if both
        // carry AON, both conditions must hold, which implies
        // `L.amount == B.amount`.
        if (L.fillMode == LibVaipakam.FillMode.Aon) {
            if (r.matchAmount != L.amount || L.amountFilled != 0) {
                r.errorCode = MatchError.AonRequiresFullFill;
                return r;
            }
        }
        if (B.fillMode == LibVaipakam.FillMode.Aon) {
            if (r.matchAmount != B.amount || B.amountFilled != 0) {
                r.errorCode = MatchError.AonRequiresFullFill;
                return r;
            }
        }

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
        if (borrowerCarryOver) {
            // §3.3 — collateral is PINNED to the carried amount (== the old
            // loan's, by the carry-over predicate). The lender's pro-rated
            // requirement must not exceed it: carry-over pledges no fresh
            // collateral to top up, so a higher requirement is unfillable. When
            // it fits, lock the full carried amount (the borrower keeps it; the
            // lender is at-least-fully-secured). The synthetic HF/LTV gate below
            // then runs on this pinned value — so a lender asking for LESS
            // collateral than carried can't spuriously trip it (design §3.3).
            if (reqFromLender > B.collateralAmount) {
                r.errorCode = MatchError.RefinanceCarryOverCollateralShortfall;
                return r;
            }
            r.reqCollateral = B.collateralAmount;
        } else {
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
            // Single-value / legacy mode — pre-#164 semantic exactly when
            // `borrowerCollFloor == 0`: the borrower's posted collateral must
            // cover the lender's pro-rated requirement; the LOCKED amount stays
            // at that requirement and the OfferMatchFacet excess-refund hook
            // returns the overage to the borrower's wallet.
            //
            // #616 round-3 (Codex P1/P2): a signed-BORROWER slice passes its
            // own posted (constant-ratio) collateral as `borrowerCollFloor`,
            // so the requirement is clamped UP to the signer's floor. Because
            // the gate below runs on `picked`, the HF/LTV check sees the
            // floored collateral — a match safe at the signed pledge is admitted
            // even when the lender's bare requirement alone would be too low.
            // The slice pulls exactly its floor, so the dust-close refund nets
            // to zero. Clamping UP is always HF-safe (more collateral ⇒ lower
            // LTV / higher HF).
            uint256 req = reqFromLender < borrowerCollFloor
                ? borrowerCollFloor
                : reqFromLender;
            if (B.collateralAmount < req) {
                r.errorCode = MatchError.CollateralBelowRequired;
                return r;
            }
            picked = req;
        }
        r.reqCollateral = picked;
        }

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

    /// @notice #625 WI-2b — non-mutating preview of a `matchIntent` fill. Runs
    ///         the SAME intent-level guards `OfferMatchFacet.matchIntent`
    ///         enforces, IN THE SAME ORDER, then synthesizes the single-fill
    ///         lender slice in memory and runs it through the shared
    ///         {_previewMatchCore} against the stored borrower offer. Returns
    ///         the first failing reason (intent guard OR match-core code) so a
    ///         solver can decide whether to submit `matchIntent` without
    ///         spending gas on a revert.
    /// @dev    The risk-access gate (#671) is layered on by the
    ///         `RiskAccessFacet.previewIntent` wrapper — it owns the actor
    ///         resolver — so `ok` here is provisional (intent + match only);
    ///         the wrapper downgrades it if `riskBlock != 0`. The binding
    ///         guarantee that this preview agrees with the live path is the
    ///         `previewIntent` Ok ⟺ `matchIntent` succeeds agreement test.
    /// @param  solver Prospective filler (the would-be `matchIntent` caller) —
    ///         caller-sensitive because `requiresKeeperAuth` is checked against
    ///         it, not against `msg.sender` of this view.
    function previewIntent(
        address solver,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) internal view returns (IntentPreviewResult memory res) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // ── Mirror matchIntent's guard order EXACTLY (modifier first, then the
        //    body checks) so each failure maps to the precise on-chain revert. ──
        if (LibPausable.paused()) return _intentFail(res, IntentError.Paused);
        if (
            LibVaipakam.isSanctionedAddress(solver) ||
            LibVaipakam.isSanctionedAddress(lender)
        ) return _intentFail(res, IntentError.Sanctioned);
        if (!s.protocolCfg.partialFillEnabled) {
            return _intentFail(res, IntentError.MatcherDisabled);
        }
        if (!s.protocolCfg.lenderIntentEnabled) {
            return _intentFail(res, IntentError.IntentDisabled);
        }
        if (
            s.isAggregatorAdapter[lender] &&
            LibVaipakam.cfgAggregatorAdaptersPaused()
        ) return _intentFail(res, IntentError.AggregatorPaused);

        LibVaipakam.LenderIntent memory intent =
            s.lenderIntent[lender][lendingAsset][collateralAsset];
        if (!intent.active) return _intentFail(res, IntentError.Inactive);
        if (lendingAsset == s.vpfiToken) {
            return _intentFail(res, IntentError.VpfiLendingUnsupported);
        }
        if (
            intent.requiresKeeperAuth &&
            !LibAuth.isKeeperForPrincipal(
                solver, LibVaipakam.KEEPER_ACTION_SIGNED_FILL, lender
            )
        ) return _intentFail(res, IntentError.KeeperUnauthorized);
        if (fillAmount < intent.minFillAmount) {
            return _intentFail(res, IntentError.BelowMinFill);
        }

        uint256 live =
            s.lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset];
        if (live + fillAmount > intent.maxExposure) {
            return _intentFail(res, IntentError.ExposureExceeded);
        }

        LibVaipakam.Offer storage cp = s.offers[counterpartyOfferId];
        if (cp.durationDays > intent.maxDurationDays) {
            return _intentFail(res, IntentError.DurationTooLong);
        }
        if (!cp.useFullTermInterest) {
            return _intentFail(res, IntentError.FullTermRequired);
        }
        if (cp.allowsPartialRepay) {
            return _intentFail(res, IntentError.PartialRepayNotAllowed);
        }

        uint256 reqColl = LibRiskMath.minCollateralForLtvCap(
            fillAmount, lendingAsset, collateralAsset, intent.maxInitLtvBps
        );
        if (reqColl == 0 || reqColl == type(uint256).max) {
            return _intentFail(res, IntentError.CollateralUnresolvable);
        }

        // Funded-capital sufficiency: matchIntent's `unlienIntentCapital`
        // reverts `IntentCapitalInsufficient` when the fill exceeds funded
        // capital — the hard funding guard (distinct from `maxExposure`).
        uint256 capital =
            s.lenderIntentCapital[lender][lendingAsset][collateralAsset];
        res.availableCapital = capital;
        if (fillAmount > capital) {
            return _intentFail(res, IntentError.CapitalInsufficient);
        }

        // ── #747 Codex r1/r2 — slice MATERIALIZATION gates. `matchIntent` next
        //    calls `_materializeIntentSlice` → `createSignedOfferVault`, which
        //    re-validates the slice as a fresh offer. A controlled slice still
        //    reaches these create-time validators; mirror them IN THE SAME ORDER
        //    `createSignedOfferVault` runs them (Codex r2: a combined failure
        //    must report the SAME first reason as the live revert), reusing the
        //    live cfg / oracle / risk helpers. ──
        // (a) Global offer-duration cap (OfferCreateFacet:744). The borrower
        //     offer cleared this at ITS creation, but the cap may have been
        //     lowered since, and the slice re-checks the CURRENT cap.
        if (cp.durationDays > LibVaipakam.cfgMaxOfferDurationDays()) {
            return _intentFail(res, IntentError.SliceDurationAboveCap);
        }
        // (b) Per-asset pause (OfferCreateFacet:767 — `requireAssetNotPaused`
        //     on BOTH legs, before `_executeMatch`). Either paused leg fails the
        //     materialize here, ahead of the match core / risk gate.
        if (s.assetPaused[lendingAsset] || s.assetPaused[collateralAsset]) {
            return _intentFail(res, IntentError.SlicePausedAsset);
        }
        // (c) Range-mode lender collateral floor (OfferCreateFacet:919, lender
        //     branch). Runs BEFORE the cadence validator, and ONLY when range-
        //     amount is on AND BOTH legs are classified `Liquid` (same gate as
        //     the live path — Codex r2: don't apply it to a priced-but-illiquid
        //     leg). `reqColl` (the intent-LTV-cap collateral) can sit below the
        //     HF floor when the lender's `maxInitLtvBps` is more permissive.
        if (s.protocolCfg.rangeAmountEnabled) {
            bool bothLiquid =
                OracleFacet(address(this)).checkLiquidity(lendingAsset)
                    == LibVaipakam.LiquidityStatus.Liquid
                && OracleFacet(address(this)).checkLiquidity(collateralAsset)
                    == LibVaipakam.LiquidityStatus.Liquid;
            if (bothLiquid) {
                uint256 floorColl = LibRiskMath.minCollateralForLending(
                    fillAmount, lendingAsset, collateralAsset
                );
                if (floorColl > 0 && reqColl < floorColl) {
                    return _intentFail(res, IntentError.SliceCollateralBelowFloor);
                }
            }
        }
        // (d) Periodic-cadence floor (OfferCreateFacet:965, AFTER the collateral
        //     floor). The slice carries cadence `None`; `_validatePeriodicCadence`
        //     mandates at least `Annual` on any >365d term, so a None-cadence
        //     multi-year slice always reverts `CadenceNotAllowed`.
        if (cp.durationDays > 365) {
            return _intentFail(res, IntentError.SliceMultiYearTerm);
        }

        // #951 v2 (Codex #959 bind-to-live, round-8 P2/P3) — mirror
        // `_executeMatch`'s sale-vehicle rejection: a borrower offer linked via
        // `saleOfferToLoanId` is a lender-position sale, fillable ONLY through
        // direct `acceptOffer`. `matchIntent` → `_executeMatch` reverts
        // `SaleVehicleNotMatchable` on it, so preview must fail here rather than
        // return Ok. Ordered to match the live path: `_executeMatch`'s check runs
        // after the intent body + slice-materialize guards, before the match core.
        if (s.saleOfferToLoanId[counterpartyOfferId] != 0) {
            return _intentFail(res, IntentError.SaleVehicleTagged);
        }

        // ── Every intent + slice-create guard cleared. Synthesize the single-
        //    fill lender slice in memory (the values matchIntent materializes
        //    via `_intentSliceParams` + createOffer defaults) and run the shared
        //    match-admission core against the stored borrower offer. ──
        LibVaipakam.Offer memory slice = _buildIntentSlice(
            lender,
            lendingAsset,
            collateralAsset,
            fillAmount,
            reqColl,
            intent.minRateBps,
            cp.durationDays
        );
        MatchResult memory mr = _previewMatchCore(slice, cp, s, 0);
        res.intentError = IntentError.Ok;
        res.matchError = mr.errorCode;
        res.matchAmount = mr.matchAmount;
        res.matchRateBps = mr.matchRateBps;
        res.reqCollateral = mr.reqCollateral;
        // Provisional — the facet wrapper downgrades on a non-zero riskBlock.
        res.ok = (mr.errorCode == MatchError.Ok);
    }

    /// @dev Stamp an intent-guard failure and short-circuit. `ok` stays false;
    ///      `matchError` stays `Ok` (the core was never reached) and the figures
    ///      stay zero — callers key off `intentError` first.
    function _intentFail(IntentPreviewResult memory res, IntentError e)
        private
        pure
        returns (IntentPreviewResult memory)
    {
        res.intentError = e;
        res.ok = false;
        return res;
    }

    /// @dev Build the in-memory single-fill lender slice an intent fill would
    ///      materialize. Mirrors `OfferMatchFacet._intentSliceParams` for every
    ///      field {_previewMatchCore} reads; all other fields take the memory
    ///      zero-default (`amountFilled`/`collateralAmountFilled` = 0, `accepted`
    ///      = false, `expiresAt`/`refinanceTargetLoanId` = 0, ERC20 token ids /
    ///      quantities = 0) — exactly what the freshly-created slice carries.
    function _buildIntentSlice(
        address creator,
        address lendingAsset,
        address collateralAsset,
        uint256 fillAmount,
        uint256 reqColl,
        uint256 minRateBps,
        uint256 durationDays
    ) private pure returns (LibVaipakam.Offer memory o) {
        o.creator = creator;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.lendingAsset = lendingAsset;
        o.collateralAsset = collateralAsset;
        o.assetType = LibVaipakam.AssetType.ERC20;
        o.collateralAssetType = LibVaipakam.AssetType.ERC20;
        o.amount = fillAmount;
        o.amountMax = fillAmount; // single-fill slice
        o.interestRateBps = minRateBps; // the lender's floor
        o.interestRateBpsMax = LibVaipakam.MAX_INTEREST_BPS; // accept any rate ≥ floor
        o.collateralAmount = reqColl; // init-LTV-cap requirement
        o.collateralAmountMax = reqColl;
        o.durationDays = durationDays; // == counterparty term (≤ maxDuration)
        o.fillMode = LibVaipakam.FillMode.Partial;
    }
}
