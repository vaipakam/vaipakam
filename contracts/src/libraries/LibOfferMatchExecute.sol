// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibOfferMatch} from "./LibOfferMatch.sol";
import {LibAutoRefinanceCheck} from "./LibAutoRefinanceCheck.sol";
import {LibFacet} from "./LibFacet.sol";
import {RefinanceFacet} from "../facets/RefinanceFacet.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {OfferAcceptFacet} from "../facets/OfferAcceptFacet.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "../facets/EncumbranceMutateFacet.sol";
import {OfferCreateFacet} from "../facets/OfferCreateFacet.sol";
import {RiskPreviewFacet} from "../facets/RiskPreviewFacet.sol";

/**
 * @title  LibOfferMatchExecute — the match-execution core every match host shares.
 * @author Vaipakam Developer Team
 * @notice `executeMatch` is the audited core `matchOffers` and `matchSignedOffer`
 *         (OfferMatchFacet) and `matchIntent` (OfferMatchIntentFacet) all run:
 *         the validity matrix and midpoint terms, the vault pulls, the loan
 *         initiation through the accept path, the excess-collateral refund, the
 *         lender dust-close and the matcher kickback. It is an INTERNAL library
 *         function, inlined into each host, so `msg.sender` is the host's own
 *         caller: the `matchOverride.matcher`, the `OfferMatched` matcher and
 *         the LIF split resolve to the original external caller in every host.
 * @dev    #1219 (S-4) — extracted from `OfferMatchFacet` when `matchIntent`
 *         moved to its own facet (EIP-170): one source, two hosts. The events
 *         and errors the core owns live here with it; solc includes a library's
 *         events and errors in every host's ABI, so indexers and decoders see
 *         them unchanged (the `OfferMatched` topic is the one OfferFacet's
 *         indexers already filter on).
 */
library LibOfferMatchExecute {
    /// @dev Re-declared from OfferFacet so the same topic0 lands on
    ///      every match regardless of which facet emits — indexers
    ///      filter by signature, so this stays compatible with
    ///      whatever was indexing OfferFacet.OfferMatched before
    ///      the split.
    /// @notice Phase 1 Day 3 — extended (per EventSourcingAudit §3.4)
    ///         with the borrower-side post-match state so consumers no
    ///         longer need a parallel `getOffer(borrowerOfferId)` read.
    /// @param borrowerAmountFilled Post-match `s.offers[borrowerOfferId]
    ///        .amountFilled`. Phase 1 borrower offers are single-fill,
    ///        so this is `borrowerOffer.amount` once accepted; the
    ///        field becomes load-bearing in Phase 2 (borrower partials).
    /// @param borrowerAccepted Post-match `s.offers[borrowerOfferId]
    ///        .accepted` boolean — true once the borrower offer is
    ///        fully consumed.
    /// @custom:event-category state-change/offer-mutation
    event OfferMatched(
        uint256 indexed lenderOfferId,
        uint256 indexed borrowerOfferId,
        uint256 indexed loanId,
        address matcher,
        uint256 matchAmount,
        uint256 matchRateBps,
        uint256 lenderRemainingPostMatch,
        uint256 lifMatcherFee,
        uint256 borrowerAmountFilled,
        bool borrowerAccepted
    );

    /// @dev Re-declared from OfferFacet for the same reason.
    enum OfferCloseReason { FullyFilled, Dust, Cancelled }
    /// @custom:event-category state-change/offer-mutation
    event OfferClosed(uint256 indexed offerId, OfferCloseReason reason);

    error InvalidOfferType();
    error OfferAlreadyAccepted();
    error FunctionDisabled(uint8 whichFlag);
    error AssetMismatch();
    error AmountNoOverlap();
    error RateNoOverlap();
    error CollateralBelowRequired();
    error DurationMismatch();
    error MatchHFTooLow();
    error VaultWithdrawFailed();
    /// @notice #576 — a refinance-tagged offer was passed to `matchOffers`.
    ///         Refinance-tagged offers carry a collateral carry-over contract
    ///         that only the direct accept-and-refinance path can honour
    ///         atomically, so they are excluded from the partial-fill matcher.
    error RefinanceTaggedOfferNotMatchable();
    /// @notice #951 (redesign D3) — a lender position-sale vehicle (a Borrower
    ///         offer linked via `saleOfferToLoanId`) cannot be filled through the
    ///         range matcher; it is a full, all-or-nothing transfer accepted only
    ///         through the direct `acceptOffer` path. See LenderSaleVehicleRedesign.md.
    error SaleVehicleNotMatchable();
    /// @notice #1001 (S3, Codex #1070) — a linked Preclose Option-3 offset offer
    ///         (`offsetOfferToLoanId[lenderOfferId] != 0`) cannot be filled
    ///         through the matcher; it must settle via the direct `acceptOffer` →
    ///         `completeOffsetInternal` path so the old lender is paid at
    ///         completion. Bots skip it at preview.
    error OffsetVehicleNotMatchable();
    /// @notice #595 — an admitted carry-over match where the lender's pro-rated
    ///         collateral requirement exceeds the carried (pinned) amount.
    error RefinanceCarryOverCollateralShortfall();
    /// @notice The slice materialize cross-facet call reverted with no data.
    error SignedOfferMaterializeFailed();
    /// @notice Burning the consumed transient lender-slice position NFT failed.
    error NFTBurnFailed();

    /// @dev #671 phase 2 (#728 PR-2b) — re-assert the progressive-risk gate for
    ///      BOTH paired offers' creators at the matcher, against the LIVE
    ///      tier/consent state, mirroring the create-time chokepoint
    ///      (`OfferCreateFacet`). The classification + PairId resolution
    ///      (including the borrower-offer-pair surface and the sale-vehicle
    ///      seller-exempt / buyer-gated split) lives in
    ///      `RiskPreviewFacet.assertMatchAllowed` — delegated via a cross-facet
    ///      call so the heavy classifier doesn't inline into this facet (which is
    ///      near the EIP-170 ceiling). The inner `RiskTierTooLow` /
    ///      `IlliquidPairNotConsented` revert bubbles. No-op unless
    ///      `riskAccessGateEnabled` (guarded so a gate-off match pays no
    ///      cross-call).
    function _assertMatchCreatorsRiskAccess(
        uint256 lenderOfferId,
        uint256 borrowerOfferId
    ) private {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                RiskPreviewFacet.assertMatchAllowed.selector,
                lenderOfferId,
                borrowerOfferId
            ),
            bytes4(0)
        );
    }

    /// @notice Shared match-execution core for `matchOffers`, the v0.6
    ///         `matchSignedOffer` and `matchIntent`. `msg.sender` (the matcher /
    ///         LIF recipient) is preserved because this is an internal call from
    ///         every entry — there is no `address(this)` cross-facet hop, so the
    ///         `matchOverride.matcher`, the `OfferMatched` `msg.sender`, and
    ///         the LIF split all resolve to the original external caller.
    /// @param lenderOfferId    The lender (lend) offer being matched.
    /// @param borrowerOfferId  The borrower (borrow) offer being matched.
    /// @param borrowerCollFloor A hard floor for the borrower collateral on this
    ///         match, forwarded into `previewMatch` so the floor is applied at
    ///         BOTH the lock and the HF/LTV gate (no post-hoc clamp). `0`
    ///         (matchOffers + the signed-LENDER direction) is a no-op,
    ///         byte-identical to the prior behaviour. Set non-zero ONLY by the
    ///         signed-BORROWER slice path, where the signer committed a
    ///         constant-ratio collateral for this fill that the engine's
    ///         single-value branch would otherwise refund away — see
    ///         `matchSignedOffer`. The slice pulls exactly this amount, so the
    ///         borrower-side refund nets to zero; clamping UP is always HF-safe.
    /// @return loanId          The newly initiated loan.
    function executeMatch(
        uint256 lenderOfferId,
        uint256 borrowerOfferId,
        uint256 borrowerCollFloor
    )
        internal
        returns (uint256 loanId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // #595 — carry-over-aware matched refinance. A refinance-tagged BORROWER
        // offer is matchable ONLY as an AON carry-over match that passes the
        // exhaustive admission mirror of `RefinanceFacet._refinanceLoanLogic`
        // (`LibAutoRefinanceCheck.matchAdmissible` — the SAME predicate
        // `previewMatch` uses, so on-chain and preview agree). An AON single
        // full fill consumes the borrower offer in one slice, so the dust-close
        // retag hook below fires in the SAME tx (no uncollateralized window —
        // design §2/§3), the matched collateral is pinned to the carried amount
        // (no identity-gate divergence), and the old lien is retagged atomically.
        // A LENDER offer is never refinance-tagged. Anything tagged that fails
        // admission reverts here, exactly as the atomic path would.
        if (s.offers[lenderOfferId].refinanceTargetLoanId != 0) {
            revert RefinanceTaggedOfferNotMatchable();
        }
        // #951 (redesign D3) — a lender position-sale vehicle is a full-principal,
        // all-or-nothing transfer accepted ONLY through the direct `acceptOffer`
        // path, where `offer.accepted` is set before the auto-complete hop. On the
        // match path `_acceptOffer` defers the accepted-flip to the dust-close
        // block (partialFillEnabled), which runs AFTER the auto-complete would
        // call `completeLoanSaleInternal` — so a matched sale vehicle reverts
        // `SaleOfferNotAccepted`. Reject the pair up front (bots skip it at
        // preview), rather than thread the flip earlier: a position sale is not a
        // range/partial order. See LenderSaleVehicleRedesign.md D3.
        if (s.saleOfferToLoanId[borrowerOfferId] != 0) {
            revert SaleVehicleNotMatchable();
        }
        // #1001 (S3, Codex #1070 r4) — a linked Preclose Option-3 offset offer is
        // a LENDER offer that MUST settle through `completeOffsetInternal`, which
        // only fires on the direct `acceptOffer` path (the auto-complete hop keys
        // on the accepted offer's `offsetOfferToLoanId`). On the match path the
        // accepted-flip defers to the dust-close block and the offset auto-
        // complete never runs, so a matched offset would consume the vehicle
        // WITHOUT settling the old lender — leaving the original loan Active with a
        // live link + NFT lock and, once time drifts past the maturity guard, no
        // recovery even by manual `completeOffset`. Reject up front (bots skip it
        // at preview), exactly as the sale vehicle is rejected above. An offset is
        // a full-principal transfer, not a range/partial order.
        if (s.offsetOfferToLoanId[lenderOfferId] != 0) {
            revert OffsetVehicleNotMatchable();
        }
        {
            uint256 bRefiTarget =
                s.offers[borrowerOfferId].refinanceTargetLoanId;
            if (
                bRefiTarget != 0 &&
                !LibAutoRefinanceCheck.matchAdmissible(
                    s, bRefiTarget, s.offers[borrowerOfferId]
                )
            ) {
                revert RefinanceTaggedOfferNotMatchable();
            }
        }

        // Pre-flight via the shared core; map structured errors into
        // typed reverts declared on this library.
        LibOfferMatch.MatchResult memory mr =
            LibOfferMatch.previewMatch(
                lenderOfferId, borrowerOfferId, borrowerCollFloor
            );
        if (mr.errorCode != LibOfferMatch.MatchError.Ok) {
            if (mr.errorCode == LibOfferMatch.MatchError.AssetMismatch
                || mr.errorCode == LibOfferMatch.MatchError.AssetTypeMismatch) {
                revert AssetMismatch();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.AmountNoOverlap) {
                revert AmountNoOverlap();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.RateNoOverlap) {
                revert RateNoOverlap();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.CollateralBelowRequired) {
                revert CollateralBelowRequired();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.OfferAccepted) {
                revert OfferAlreadyAccepted();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.DurationMismatch) {
                revert DurationMismatch();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.HFTooLow) {
                revert MatchHFTooLow();
            }
            // #194 — same-creator on both sides surfaces through the
            // `previewMatch` classifier here BEFORE the cross-facet
            // call reaches `_acceptOffer`'s load-bearing
            // `SelfTradeForbidden` revert. Re-raise the same typed
            // error from this facet so a matcher submitting via
            // `matchOffers` sees the SAME revert ABI the direct-accept
            // path returns. Argument is the colliding creator address
            // (lender offer creator == borrower offer creator).
            if (mr.errorCode == LibOfferMatch.MatchError.SelfTrade) {
                revert OfferAcceptFacet.SelfTradeForbidden(
                    s.offers[lenderOfferId].creator
                );
            }
            // #195 — surface the GTT terminal classifier with the
            // expired offer's id so the matcher (bot or otherwise) gets
            // a non-ambiguous revert. Either side can be the expired
            // offer; pick whichever lapsed (lender first so the report
            // is deterministic when both expired in the same second).
            // Re-raises the same typed error the direct-accept path
            // returns so the ABI is uniform across both entry points.
            if (mr.errorCode == LibOfferMatch.MatchError.OfferExpired) {
                LibVaipakam.Offer storage l_ = s.offers[lenderOfferId];
                if (LibVaipakam.isOfferExpired(l_)) {
                    revert OfferAcceptFacet.OfferExpired(
                        lenderOfferId,
                        l_.expiresAt
                    );
                }
                LibVaipakam.Offer storage b_ = s.offers[borrowerOfferId];
                revert OfferAcceptFacet.OfferExpired(
                    borrowerOfferId,
                    b_.expiresAt
                );
            }
            // #125 — AON terminal: the match would land a partial-fill
            // against an AON offer, which violates its "single full
            // fill" contract. Surface the offending offerId so the
            // matcher's revert decoder can render "offer X is AON;
            // your match would have only filled Y of Z." Pick the
            // AON side (lender first deterministically when both
            // carry AON).
            if (mr.errorCode == LibOfferMatch.MatchError.AonRequiresFullFill) {
                LibVaipakam.Offer storage lAon = s.offers[lenderOfferId];
                if (lAon.fillMode == LibVaipakam.FillMode.Aon) {
                    revert OfferAcceptFacet.AonRequiresFullFill(
                        lenderOfferId,
                        lAon.amount,
                        mr.matchAmount
                    );
                }
                LibVaipakam.Offer storage bAon = s.offers[borrowerOfferId];
                revert OfferAcceptFacet.AonRequiresFullFill(
                    borrowerOfferId,
                    bAon.amount,
                    mr.matchAmount
                );
            }
            // #595 — an admitted carry-over match where the lender's pro-rated
            // collateral requirement exceeds the carried (pinned) amount.
            // Surface a dedicated revert (not the generic InvalidOfferType) so
            // callers can distinguish it from a malformed offer.
            if (
                mr.errorCode ==
                LibOfferMatch.MatchError.RefinanceCarryOverCollateralShortfall
            ) {
                revert RefinanceCarryOverCollateralShortfall();
            }
            revert InvalidOfferType();
        }

        // #671 phase 2 (#728 PR-2b) — keeper-match risk re-assertion. The
        // acceptor-side gate in `LoanFacet._maybeRunInitialRiskGates` is scoped
        // to the direct-accept path (`acceptAckActive == true`) and is SKIPPED on
        // the keeper-match path (a match sets no accept-ack — both sides are
        // self-authored offers, design §5), so neither party is re-validated
        // downstream. Re-assert HERE — before any state mutation. The gated
        // parties + the pair they are gated against are resolved in
        // `RiskPreviewFacet.assertMatchAllowed`: a normal match gates BOTH
        // creators against the BORROWER offer's pair (the resulting loan copies
        // its token ids / prepay from that offer, so the lender must consent to
        // the pair it actually joins, not its own offer's possibly-different
        // pair); a lender-sale-vehicle borrower offer instead exempts the exiting
        // seller and gates only the buyer (the lender-offer creator acquiring the
        // sold position) against the LINKED loan's pair — mirroring the
        // sale-vehicle accept semantics (PR-2a). Standing consent only (no #662
        // ack on this path). No-op unless the kill-switch is on.
        _assertMatchCreatorsRiskAccess(lenderOfferId, borrowerOfferId);

        // ── State mutation: install the match override. See the
        // matching docstring on `OfferFacet._acceptOffer` for the
        // override-slot consumer side. `mr.reqCollateral` already reflects the
        // signed-borrower floor (threaded into previewMatch above), so the
        // override, the offer-lien decrement, and the dust-close refund all
        // key off the SAME value and stay consistent.
        LibVaipakam.MatchOverride storage mo = s.matchOverride;
        mo.amount = mr.matchAmount;
        mo.rateBps = mr.matchRateBps;
        mo.collateralAmount = mr.reqCollateral;
        mo.counterparty = s.offers[lenderOfferId].creator;
        mo.matcher = msg.sender;
        mo.active = true;
        // #1369 — the lender's Full-tariff authorization lives on THEIR offer,
        // which `acceptOfferInternal` never sees (it is handed the borrower
        // offer). Carry the id so `FeeEntitlementFacet.chargeFullTariff` can
        // resolve the lender side from the artifact that party signed, instead
        // of falling through to the direct-accept transient and resolving a
        // Full lender as non-Full. Read is gated on `mo.active`, cleared below.
        s.matchLenderAuthOfferId = lenderOfferId;

        // T-407-C (#566) — decrement the lender's offer-principal lock
        // by this fill BEFORE `acceptOfferInternal` withdraws the same
        // `mr.matchAmount` of principal from the lender's vault below.
        // The lock was created at offer-create over the full `amountMax`;
        // each fill draws a slice out, so the lien must shrink in lock-
        // step or the vault-withdraw chokepoint would treat the slice as
        // still encumbered and revert the disbursement. The remaining
        // lock (covering the still-unfilled capacity) is released at the
        // dust-close block below. No-op on a lender offer that never
        // carried a lock (defensive — match-eligible lender offers are
        // always ERC20).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                lenderOfferId,
                mr.matchAmount
            ),
            bytes4(0)
        );

        // Cross-facet call into OfferFacet's internal acceptor entry
        // — same body as `OfferFacet.acceptOffer`, but without
        // re-acquiring the (already-held) nonReentrant lock. The
        // `address(this)`-only guard inside acceptOfferInternal
        // prevents EOAs from calling it directly.
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferAcceptFacet.acceptOfferInternal.selector,
                borrowerOfferId,
                /* acceptorRiskAndTermsConsent */ true,
                /* usePermit */ false
            ),
            // Surface a clear typed revert on cross-facet failure;
            // the inner revert reason still bubbles via the helper.
            VaultWithdrawFailed.selector
        );
        loanId = abi.decode(ret, (uint256));

        // #573 — decrement the BORROWER offer's collateral lock by the
        // collateral this fill consumed. Done AFTER `acceptOfferInternal`
        // (Codex P1): the inner `_acceptOffer` pays the VPFI Loan-Initiation
        // Fee out of the borrower's vault BEFORE `initiateLoan` creates the
        // child loan's collateral lien. If the collateral asset is VPFI and
        // we decremented the offer lock BEFORE that, `reqCollateral` would
        // momentarily look free to the VPFI withdraw guard and the LIF
        // could be paid out of collateral meant to back the loan. Deferring
        // to here keeps the offer lock covering this fill's collateral
        // throughout the LIF; by now `createCollateralLien` has already
        // re-encumbered `reqCollateral` under the loan, so the net
        // aggregate is unchanged (offer-lock −reqCollateral, loan-lien
        // +reqCollateral). The unfilled remainder is released at the
        // borrower dust-close / single-fill refund below. No-op on a
        // borrower offer with no collateral lock (NFT collateral, or none).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                borrowerOfferId,
                mr.reqCollateral
            ),
            bytes4(0)
        );

        // Clear the override now that the loan is initiated. Critical:
        // any subsequent same-tx initiateLoan calls (e.g., a follow-up
        // strategic flow) MUST fall through to the legacy field-read
        // path.
        delete s.matchOverride;
        delete s.matchLenderAuthOfferId;

        // ── Borrower-side excess-collateral refund (Range Orders
        // Phase 1, symmetric with the lender-side dust-close below).
        //
        // OfferCreateFacet pre-vaults the borrower's collateral
        // UPPER bound at create-time (`offer.collateralAmountMax`,
        // post auto-collapse). The match locked `mr.reqCollateral`
        // — which is `clamp(reqFromLender, [B.collateralAmount,
        // B.collateralAmountMax])` per #164's clamp-up semantics.
        // The unused tail `B.collateralAmountMax - mr.reqCollateral`
        // is refunded to the borrower's wallet immediately so the
        // invariant "vault only holds collateral committed to an
        // active offer or live loan" stays clean. Since borrower
        // offers are single-fill in Phase 1, the tail can never be
        // reused by another match — leaving it in vault would trap
        // the funds. On a legacy single-value borrower offer
        // (auto-collapsed `collateralAmountMax == collateralAmount`)
        // this code path lands at the same numbers as the pre-#164
        // implementation, byte-for-byte.
        //
        // ERC-20 collateral only: NFT collateral (ERC-721 / ERC-1155)
        // is whole-or-nothing — the borrower posts exactly the token
        // ids and quantity the offer references, so reqCollateral
        // always equals borrowerOffer.collateralAmount and there's
        // never overage to refund.
        // Issue #102 — borrower-side per-match refund is now CONDITIONAL
        // on partial-fill mode. Under Phase 1 single-fill (the fallback
        // when `partialFillEnabled` is off), the entire excess
        // `collateralAmountMax - mr.reqCollateral` is refunded on the
        // first (and only) match — that's the existing #164 behaviour.
        // Under partial-fill (#102), the borrower's pre-vaulted
        // collateral STAYS in custody across matches; only the residual
        // is refunded on dust-close at the bottom of this function.
        // Distinguish via the same flag `OfferAcceptFacet._acceptOffer`
        // uses for the symmetric `accepted = true` deferral.
        if (!s.protocolCfg.partialFillEnabled) {
            LibVaipakam.Offer storage B = s.offers[borrowerOfferId];
            if (B.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                // #573 — single-fill fully consumes the borrower offer;
                // release the remaining offer-collateral lock BEFORE the
                // excess refund. After the per-fill decrement above the
                // lock equals exactly the excess about to be returned, so
                // leaving it active would block the creator's own refund.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                        borrowerOfferId
                    ),
                    bytes4(0)
                );
                // Legacy fallback: a borrower offer created before
                // #164 carries `collateralAmountMax == 0` in storage.
                // Read-side then collapses to `collateralAmount` so
                // the pulled / refunded amounts agree with the pre-
                // #164 deposit.
                uint256 borrowerPulled = B.collateralAmountMax == 0
                    ? B.collateralAmount
                    : B.collateralAmountMax;
                if (borrowerPulled > mr.reqCollateral) {
                    uint256 excess = borrowerPulled - mr.reqCollateral;
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
                            B.creator,           // pull from borrower's vault
                            B.collateralAsset,
                            B.creator,           // refund to borrower's wallet
                            excess
                        ),
                        VaultWithdrawFailed.selector
                    );
                }
            }
        }

        // ── Lender-side post-match accounting. Under Phase 1 single-
        // fill, the borrower offer was already marked `accepted = true`
        // by `_acceptOffer`; under #102 partial-fill, the borrower-side
        // accounting block BELOW handles the dust-close + accept-flip
        // for borrower offers (symmetric to this lender-side block).
        LibVaipakam.Offer storage L = s.offers[lenderOfferId];
        L.amountFilled += mr.matchAmount;
        uint256 lenderRemaining = L.amountMax - L.amountFilled;

        // Auto-close on dust: if the leftover can't satisfy the
        // lender's per-match minimum (`L.amount`), refund the dust to
        // the lender's wallet and flip `accepted = true`. The same
        // condition fires when the lender is fully filled
        // (`lenderRemaining == 0`).
        if (lenderRemaining < L.amount) {
            // T-407-C (#566) — the lender offer is now terminal (dust-
            // close or full-fill). Release whatever offer-principal lock
            // remains BEFORE the dust refund below. After this match's
            // decrement the residual lock equals `lenderRemaining`
            // exactly, so the release frees precisely the dust about to
            // be withdrawn; on a clean full-fill (`lenderRemaining == 0`)
            // the lock is already drained and the release just tombstones
            // the row. Pairs with the OfferAcceptFacet single-fill
            // release + the OfferCancelFacet release — every terminal a
            // lender offer can reach drops its lock exactly once.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                    lenderOfferId
                ),
                bytes4(0)
            );
            if (lenderRemaining > 0) {
                // Dust refund: pull the unfilled remainder back to the
                // lender's wallet. createOffer pre-vaulted amountMax;
                // _acceptOffer already pulled `mr.matchAmount` for the
                // borrower's principal, leaving `lenderRemaining` still
                // in custody. Lender ERC-20 only — NFT / ERC1155 lender
                // offers are single-fill (amount == amountMax) so this
                // branch is unreachable for them in practice.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        L.creator,
                        L.lendingAsset,
                        L.creator,
                        lenderRemaining
                    ),
                    VaultWithdrawFailed.selector
                );
            }
            L.accepted = true;
            emit OfferClosed(
                lenderOfferId,
                lenderRemaining == 0
                    ? OfferCloseReason.FullyFilled
                    : OfferCloseReason.Dust
            );
        }

        // ── Borrower-side post-match accounting (Issue #102; symmetric
        // with the lender block above). Only fires when
        // `partialFillEnabled` is ON — otherwise the inner `_acceptOffer`
        // already flipped `accepted = true` on the borrower offer (Phase
        // 1 single-fill fallback). When ON, this block:
        //   - Increments `B.amountFilled` + `B.collateralAmountFilled`
        //     by the matched amounts.
        //   - Auto-closes on dust: if the leftover can't satisfy the
        //     borrower's per-match minimum (`B.amount`), refund the
        //     residual collateral to the borrower's wallet and flip
        //     `accepted = true`. Mirrors the lender-side dust-close
        //     condition exactly.
        LibVaipakam.Offer storage bm = s.offers[borrowerOfferId];
        if (s.protocolCfg.partialFillEnabled && !bm.accepted) {
            bm.amountFilled += mr.matchAmount;
            bm.collateralAmountFilled += mr.reqCollateral;
            // #183 (Canonical Limit-Order Phase 2): direct storage read
            // for the borrower's effective ceiling. The GTC derivation
            // (`amountMax == 0 → derive from collateralAmountMax ×
            // init-LTV cap`) is deleted — under the new invariant
            // `amountMax > 0`, storage never holds the zero sentinel.
            // Frontend computes the value at create-time and ships
            // explicit non-zero; see
            // `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md` §5.
            uint256 effBorrowerAmountMax = bm.amountMax;
            uint256 borrowerRemaining = effBorrowerAmountMax - bm.amountFilled;
            if (borrowerRemaining < bm.amount) {
                // Dust-close: refund residual collateral and flip accepted.
                // #595 §3.4 — SKIP the offer-lock release + collateral refund for
                // a carry-over refinance offer: it pledged NO fresh collateral
                // (OfferCreateFacet's carry-over deposit/escrow-lock skips) and
                // its backing is the old loan's lien, untouched until the retag
                // hook below. Running the refund here would either revert at the
                // vault-withdraw guard (no free balance) or drain unrelated free
                // collateral. Only the accepted-flip, metrics hook, and retag run.
                if (
                    bm.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
                    !bm.refinanceCarryOver
                ) {
                    // #573 — borrower offer is now terminal; release the
                    // remaining offer-collateral lock BEFORE the residual
                    // refund. After the per-fill decrements the lock equals
                    // `collateralAmountMax - collateralAmountFilled` — exactly
                    // the residual about to be returned — so leaving it
                    // active would block the refund. Pairs with the
                    // single-fill release above + the OfferAcceptFacet
                    // direct-accept hand-off: every terminal a borrower
                    // offer reaches drops its collateral lock exactly once.
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                            borrowerOfferId
                        ),
                        bytes4(0)
                    );
                    uint256 borrowerCollPulled = bm.collateralAmountMax == 0
                        ? bm.collateralAmount
                        : bm.collateralAmountMax;
                    if (borrowerCollPulled > bm.collateralAmountFilled) {
                        uint256 collRefund = borrowerCollPulled - bm.collateralAmountFilled;
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultWithdrawERC20.selector,
                                bm.creator,           // pull from borrower's vault
                                bm.collateralAsset,
                                bm.creator,           // refund to borrower's wallet
                                collRefund
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                }
                bm.accepted = true;
                // Codex round-1 P1 — pair the metrics-hook fire with
                // the accept-flip. The hook was deferred by
                // `OfferAcceptFacet._acceptOffer` on every partial-fill
                // match against this borrower offer; we fire it ONCE
                // here at dust-close so the offer leaves the active-
                // discovery indexes at the moment it actually becomes
                // terminal. Two state changes (`accepted = true` +
                // active-list removal) stay tightly coupled and can't
                // drift.
                LibMetricsHooks.onOfferAccepted(borrowerOfferId);
                emit OfferClosed(
                    borrowerOfferId,
                    borrowerRemaining == 0
                        ? OfferCloseReason.FullyFilled
                        : OfferCloseReason.Dust
                );

                // T-092-H (#549) — atomic accept-and-refinance,
                // MATCHED path. Pairs the chain hook with the
                // deferred `accepted = true` flip just set above.
                // Without this hook the matched path would NOT
                // atomic-chain (Codex round-1 P2 on closed PR
                // #542). Mirrors the direct-path hook in
                // OfferAcceptFacet._acceptOffer. #2349 — a matcher fill
                // chains into the MATCH entry, which the auto-refinance
                // kill switch gates (the lender-accept entry is not).
                if (bm.refinanceTargetLoanId != 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            RefinanceFacet.refinanceLoanFromMatch.selector,
                            bm.refinanceTargetLoanId,
                            borrowerOfferId
                        ),
                        bytes4(0)
                    );
                }
            }
        }
        // §3.4 — borrower-side post-match snapshot.
        // Pre-#102 (single-fill): `amountFilled` storage stays 0 even
        //   when `accepted == true`; the event reports the EFFECTIVE
        //   post-match fill (= the offer's `amount` once accepted).
        // Post-#102 (partial-fill ON): `amountFilled` accumulates per
        //   match; the event reports it directly.
        uint256 borrowerEffFilled = (s.protocolCfg.partialFillEnabled || bm.amountFilled > 0)
            ? bm.amountFilled
            : (bm.accepted ? bm.amount : 0);
        emit OfferMatched(
            lenderOfferId,
            borrowerOfferId,
            loanId,
            msg.sender,
            mr.matchAmount,
            mr.matchRateBps,
            lenderRemaining,
            // lifMatcherFee (event display, gross): the matcher share of the
            // LIST-rate LIF. #1352 — the actual matcher payment inside
            // `_acceptOffer` is on the borrower's HoldOnly-DISCOUNTED LIF, so a
            // consenting tier-holder's real matcher fee is lower than this
            // figure; the exact paid amount is the on-chain transfer. Computed
            // at the list rate here on purpose: threading the borrower's
            // hold-tier discount into this facet inlines the discount resolver
            // and pushes OfferMatchFacet past the EIP-170 runtime-size limit,
            // and this is a convenience estimate, not the authoritative amount.
            (mr.matchAmount * LibVaipakam.cfgLoanInitiationFeeBps()
                * LibVaipakam.cfgLifMatcherFeeBps())
                / (LibVaipakam.BASIS_POINTS * LibVaipakam.BASIS_POINTS),
            borrowerEffFilled,
            bm.accepted
        );
    }
}
