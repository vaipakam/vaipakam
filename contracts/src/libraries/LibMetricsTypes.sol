// src/libraries/LibMetricsTypes.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibMetricsTypes
 * @notice Lean FLAT projections of {LibVaipakam.Loan}/{Offer} for the
 *         paginated dashboard array-views, plus shared storage->DTO
 *         converters. Returning an array of the FULL struct inflates the
 *         viaIR ABI-coder's peak stack; a flat ~18-field projection keeps
 *         the array coder shallow. Lossy vs the full struct on purpose
 *         (rental/periodic/listing/snapshot fields omitted) — consumers
 *         needing those call the single-struct getLoanDetails/getOffer* views.
 * @dev    #1025 — also home to the canonical {OfferState} enum + its
 *         {deriveOfferState} derivation (hoisted out of MetricsFacet so both
 *         MetricsFacet and MetricsDashboardFacet's bulk `getOffersWithState`
 *         share ONE terminal-precedence definition — no drift), plus the
 *         {OfferView}/{LoanView} bulk-by-id DTOs those views return.
 */
library LibMetricsTypes {
    /// @notice #1025 (hoisted from MetricsFacet, #955) — the canonical
    ///         lifecycle state of an offer. `ConsumedBySale` is the
    ///         no-loan parallel-sale terminal (Scenario A) — a distinct
    ///         surface from `Cancelled` so the frontend can render
    ///         "Sold — no loan opened". Appended last so existing indexed
    ///         value bindings (0=Open,1=Accepted,2=Cancelled) are preserved.
    ///         Enum is `uint8` at the ABI boundary, so hoisting the type is
    ///         wire-compatible; only the exported `internalType` string moves
    ///         from `MetricsFacet.OfferState` to `LibMetricsTypes.OfferState`.
    // #1195 B2 (Pass-2, §1075) — `Expired` appended at the END so existing
    // ordinals (Open=0 … ConsumedBySale=3) are unchanged and the `uint8` wire
    // encoding stays compatible; a lapsed GTT offer now reads `Expired` instead
    // of masquerading as `Open`.
    enum OfferState { Open, Accepted, Cancelled, ConsumedBySale, Expired }
    struct OfferSummary {
        uint256 id;
        LibVaipakam.OfferType offerType;
        bool accepted;
        uint64 createdAt;
        uint64 expiresAt;
        address lendingAsset;
        LibVaipakam.AssetType assetType;
        uint256 amount;
        uint256 amountMax;
        uint256 interestRateBps;
        uint256 interestRateBpsMax;
        uint256 durationDays;
        uint256 tokenId;
        uint256 amountFilled;
        address collateralAsset;
        LibVaipakam.AssetType collateralAssetType;
        uint256 collateralAmount;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
    }

    struct LoanSummary {
        uint256 id;
        uint256 offerId;
        uint256 principal;
        address principalAsset;
        LibVaipakam.AssetType assetType;
        uint256 tokenId;
        uint256 interestRateBps;
        uint256 durationDays;
        uint64 startTime;
        LibVaipakam.LoanStatus status;
        address collateralAsset;
        uint256 collateralAmount;
        LibVaipakam.AssetType collateralAssetType;
        uint256 collateralTokenId;
        uint256 lenderTokenId;
        uint256 borrowerTokenId;
        bool allowsPartialRepay;
        uint16 liquidationLtvBpsAtInit;
        // #394 Lever A (Codex #647 round-6) — the loan's snapshotted admission
        // HF floor (1e18-scaled). Carried in the dashboard projection so the HF
        // gauge colours each open loan against the floor IT was admitted under
        // (not a stale 1.5) after a governance retune. uint64 holds ≫ 2e18.
        uint64 minHealthFactorAtInit;
    }

    /// @dev #625 WI-2a — one row of `MetricsFacet.getActiveLenderIntents`: the lender's
    ///      standing bounds plus the two figures a keeper needs to size a fill —
    ///      `livePrincipal` (exposure already out) and `availableCapital` (un-lent, liened
    ///      capital the fill draws from; a fill exceeding it reverts
    ///      `IntentCapitalInsufficient`). `requiresKeeperAuth` lets the keeper skip an
    ///      intent it isn't delegated to fill.
    struct LenderIntentSummary {
        address owner;
        address lendingAsset;
        address collateralAsset;
        uint256 maxExposure;
        uint256 minRateBps;
        uint16 maxInitLtvBps;
        uint32 maxDurationDays;
        uint256 minFillAmount;
        bool requiresKeeperAuth;
        uint256 livePrincipal;
        uint256 availableCapital;
    }

    function toLenderIntentSummary(
        LibVaipakam.IntentKey memory key,
        LibVaipakam.LenderIntent storage i,
        uint256 livePrincipal,
        uint256 availableCapital
    ) internal view returns (LenderIntentSummary memory s) {
        s = LenderIntentSummary({
            owner: key.owner,
            lendingAsset: key.lendingAsset,
            collateralAsset: key.collateralAsset,
            maxExposure: i.maxExposure,
            minRateBps: i.minRateBps,
            maxInitLtvBps: i.maxInitLtvBps,
            maxDurationDays: i.maxDurationDays,
            minFillAmount: i.minFillAmount,
            requiresKeeperAuth: i.requiresKeeperAuth,
            livePrincipal: livePrincipal,
            availableCapital: availableCapital
        });
    }

    /// @dev #755 — one row of `LenderIntentFacet.getLenderIntentsByOwner`: the
    ///      lender's own standing intent PLUS an `active` flag. The global
    ///      keeper feed (`getActiveLenderIntents`) lists only ACTIVE intents, so
    ///      it needs no such flag; the per-owner management view also surfaces
    ///      PAUSED (cancelled-but-capital-reserved) intents and so must tell the
    ///      two apart. This is a SEPARATE wrapper type — deliberately NOT a new
    ///      field on the shared {LenderIntentSummary} — so the global feed's
    ///      tuple-array ABI stays byte-for-byte stable across a diamond upgrade
    ///      (an extra field there would shift every decoder's per-row stride;
    ///      Codex #756 P1).
    struct OwnerLenderIntentSummary {
        LenderIntentSummary intent;
        bool active;
    }

    function toOwnerLenderIntentSummary(
        LibVaipakam.IntentKey memory key,
        LibVaipakam.LenderIntent storage i,
        uint256 livePrincipal,
        uint256 availableCapital
    ) internal view returns (OwnerLenderIntentSummary memory s) {
        s = OwnerLenderIntentSummary({
            intent: toLenderIntentSummary(key, i, livePrincipal, availableCapital),
            active: i.active
        });
    }

    /// @dev #625 WI-2c — one row of `MetricsFacet.getRollableIntentLoans`: a
    ///      fully-repaid intent-originated loan a keeper can AUTO-ROLL via
    ///      `LenderIntentFacet.rollIntentLoan(loanId)`. `owner` /
    ///      `lendingAsset` / `collateralAsset` come from the per-loan
    ///      `intentOrigin` (NOT the live `loan.lender`, which a position sale
    ///      mutates — a sold position is reported but `rollIntentLoan` rejects
    ///      it, so the keeper still keys auth off `owner`). `amount` is the
    ///      original fill that would be re-liened as intent capital.
    struct RollableIntentLoan {
        uint256 loanId;
        address owner;
        address lendingAsset;
        address collateralAsset;
        uint256 amount;
    }

    function toRollableIntentLoan(
        uint256 loanId,
        LibVaipakam.IntentOrigin memory io
    ) internal pure returns (RollableIntentLoan memory r) {
        r = RollableIntentLoan({
            loanId: loanId,
            owner: io.owner,
            lendingAsset: io.lendingAsset,
            collateralAsset: io.collateralAsset,
            amount: io.amount
        });
    }

    function toOfferSummary(LibVaipakam.Offer storage o)
        internal view returns (OfferSummary memory s)
    {
        s = OfferSummary({
            id: o.id, offerType: o.offerType, accepted: o.accepted,
            createdAt: o.createdAt, expiresAt: o.expiresAt,
            lendingAsset: o.lendingAsset, assetType: o.assetType,
            amount: o.amount, amountMax: o.amountMax,
            interestRateBps: o.interestRateBps, interestRateBpsMax: o.interestRateBpsMax,
            durationDays: o.durationDays, tokenId: o.tokenId, amountFilled: o.amountFilled,
            collateralAsset: o.collateralAsset, collateralAssetType: o.collateralAssetType,
            collateralAmount: o.collateralAmount, collateralTokenId: o.collateralTokenId,
            collateralQuantity: o.collateralQuantity
        });
    }

    function toLoanSummary(LibVaipakam.Loan storage l)
        internal view returns (LoanSummary memory s)
    {
        s = LoanSummary({
            id: l.id, offerId: l.offerId, principal: l.principal,
            principalAsset: l.principalAsset, assetType: l.assetType, tokenId: l.tokenId,
            interestRateBps: l.interestRateBps, durationDays: l.durationDays,
            startTime: l.startTime, status: l.status,
            collateralAsset: l.collateralAsset, collateralAmount: l.collateralAmount,
            collateralAssetType: l.collateralAssetType, collateralTokenId: l.collateralTokenId,
            lenderTokenId: l.lenderTokenId, borrowerTokenId: l.borrowerTokenId,
            allowsPartialRepay: l.allowsPartialRepay,
            liquidationLtvBpsAtInit: l.liquidationLtvBpsAtInit,
            minHealthFactorAtInit: l.minHealthFactorAtInit
        });
    }

    // ─── #1025 bulk wallet-dashboard views: state derivation + DTOs ──────────

    /// @notice #1025 (hoisted from MetricsFacet `_offerStateOf`, #955) — the
    ///         canonical {OfferState} of `offerId` from storage, with terminal
    ///         precedence Accepted > Cancelled > ConsumedBySale > Open. SINGLE
    ///         source of truth: both `MetricsFacet.getOfferState` /
    ///         `get*OffersByStatePaginated` and the bulk
    ///         `MetricsDashboardFacet.getOffersWithState` call this, so the two
    ///         facets can never disagree on an offer's lifecycle.
    /// @dev    Matches the terminal flags set by `OfferFacet.acceptOffer`
    ///         (accepted) and `cancelOffer` (offerCancelled + storage-delete).
    ///         A never-existed / cancel-deleted id (`o.id == 0`) returns
    ///         `Cancelled` — legacy-compat; callers that must distinguish
    ///         "never existed" pre-filter via getGlobalCounts/getAllOffersPaginated.
    ///         The keep-listing-live design lets an offer be BOTH accepted AND
    ///         sold, so `accepted` is checked first (the loan exists — "Accepted"
    ///         is the right surface state even if a parallel sale later settles).
    function deriveOfferState(LibVaipakam.Storage storage s, uint256 offerId)
        internal
        view
        returns (OfferState)
    {
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.id != 0 && o.accepted) return OfferState.Accepted;
        if (s.offerCancelled[offerId]) return OfferState.Cancelled;
        if (o.id == 0) return OfferState.Cancelled; // never-existed OR cancel-deleted
        if (s.offerConsumedBySale[offerId]) return OfferState.ConsumedBySale;
        // #1195 B2 (Pass-2, §1075) — a lapsed GTT offer is distinguished as
        // `Expired` (fills already refuse it via `expiresAt`); sits just above
        // `Open` so the terminal states (Accepted/Cancelled/ConsumedBySale) keep
        // precedence. `deriveOfferState` is already `view`; this only widens the
        // returned domain (a previously-`Open` id can now read `Expired` once
        // `block.timestamp >= expiresAt`), with no state write.
        if (LibVaipakam.isOfferExpired(o)) return OfferState.Expired;
        return OfferState.Open;
    }

    /// @notice #1025 — one element of `getOffersWithState`. A FLAT projection of
    ///         the exact offer render-set the wallet dashboard draws (the 19
    ///         {OfferSummary} fields + the 10 it omits that the row needs) PLUS
    ///         the derived {OfferState}, so one bulk call replaces the per-id
    ///         `getOffer` + `getOfferState` pair. Flat (not a nested
    ///         {OfferSummary}) on purpose — sub-structing an ABI-boundary type
    ///         DEEPENS the array coder's peak stack, the opposite of what the
    ///         lean-DTO rule wants (#603 lever).
    struct OfferView {
        // --- the 19 OfferSummary render fields ---
        uint256 id;
        LibVaipakam.OfferType offerType;
        bool accepted;
        uint64 createdAt;
        uint64 expiresAt;
        address lendingAsset;
        LibVaipakam.AssetType assetType;
        uint256 amount;
        uint256 amountMax;
        uint256 interestRateBps;
        uint256 interestRateBpsMax;
        uint256 durationDays;
        uint256 tokenId;
        uint256 amountFilled;
        address collateralAsset;
        LibVaipakam.AssetType collateralAssetType;
        uint256 collateralAmount;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
        // --- the 10 fields OfferSummary omits but the dashboard row renders ---
        address creator;
        LibVaipakam.LiquidityStatus principalLiquidity;
        LibVaipakam.LiquidityStatus collateralLiquidity;
        uint256 quantity;
        uint256 positionTokenId;
        address prepayAsset;
        bool useFullTermInterest;
        bool creatorRiskAndTermsConsent;
        bool allowsPartialRepay;
        LibVaipakam.FillMode fillMode;
        // --- the reason this view exists ---
        OfferState state;
    }

    /// @notice #1025 — one element of `getLoansBatch`. The lean {LoanSummary}
    ///         (which already carries `status`, both position tokenIds for role
    ///         derivation, and every rendered numeric/asset field) PLUS the two
    ///         counterparty display addresses it omits. Mirrors the proven
    ///         `MetricsDashboardFacet.LoanWithRisk` wrapper shape (LoanSummary
    ///         nested + scalar tail) — one-level nesting that ships today.
    struct LoanView {
        LoanSummary loan;
        address lender;
        address borrower;
    }

    /// @notice #1025 — project a storage `Offer` (+ its already-derived state)
    ///         into the flat {OfferView}. `state` is passed in (not re-derived)
    ///         so the caller loads the row once and derives once.
    function toOfferView(LibVaipakam.Offer storage o, OfferState st)
        internal view returns (OfferView memory v)
    {
        v = OfferView({
            id: o.id, offerType: o.offerType, accepted: o.accepted,
            createdAt: o.createdAt, expiresAt: o.expiresAt,
            lendingAsset: o.lendingAsset, assetType: o.assetType,
            amount: o.amount, amountMax: o.amountMax,
            interestRateBps: o.interestRateBps, interestRateBpsMax: o.interestRateBpsMax,
            durationDays: o.durationDays, tokenId: o.tokenId, amountFilled: o.amountFilled,
            collateralAsset: o.collateralAsset, collateralAssetType: o.collateralAssetType,
            collateralAmount: o.collateralAmount, collateralTokenId: o.collateralTokenId,
            collateralQuantity: o.collateralQuantity,
            creator: o.creator,
            principalLiquidity: o.principalLiquidity,
            collateralLiquidity: o.collateralLiquidity,
            quantity: o.quantity,
            positionTokenId: o.positionTokenId,
            prepayAsset: o.prepayAsset,
            useFullTermInterest: o.useFullTermInterest,
            creatorRiskAndTermsConsent: o.creatorRiskAndTermsConsent,
            allowsPartialRepay: o.allowsPartialRepay,
            fillMode: o.fillMode,
            state: st
        });
    }

    /// @notice #1025 — project a storage `Loan` into the {LoanView} (lean
    ///         summary + the two counterparty addresses).
    function toLoanView(LibVaipakam.Loan storage l)
        internal view returns (LoanView memory v)
    {
        v = LoanView({
            loan: toLoanSummary(l),
            lender: l.lender,
            borrower: l.borrower
        });
    }
}
