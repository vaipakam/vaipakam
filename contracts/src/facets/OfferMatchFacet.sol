// src/facets/OfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title OfferMatchFacet
 * @author Vaipakam Developer Team
 * @notice Range Orders Phase 1 — bot-driven offer matching surface.
 *         Hosts the two entry points the keeper-bot consumes:
 *           - `previewMatch(L, B)` — pure preview that runs the
 *             validity matrix + computes the midpoint match terms
 *             so bots filter candidate pairs without paying for
 *             reverting txs.
 *           - `matchOffers(L, B)` — permissionless write that
 *             executes the match: pulls vaulted assets, mints the
 *             position NFTs, initiates the loan, refunds excess
 *             collateral, dust-closes the lender offer when its
 *             remaining range capacity drops below the per-match
 *             minimum, and pays the matcher kickback.
 *
 * @dev Carved out of `OfferFacet` to bring `OfferFacet`'s runtime
 *      bytecode under the EIP-170 24576-byte ceiling — the Range
 *      Orders Phase 1 work pushed it ~4KB over. Conceptually this
 *      is the right cut anyway: matching is bot-facing and
 *      semantically distinct from create / accept / cancel.
 *
 *      Cross-facet reuse: `matchOffers` reuses the heavy LIF +
 *      vault + NFT-mint + loan-init plumbing already in
 *      `OfferFacet._acceptOffer` by calling
 *      `OfferFacet.acceptOfferInternal(...)` through the diamond
 *      fallback. The internal entry point gates on
 *      `msg.sender == address(this)` so EOAs can never call it
 *      directly. Reentrancy: the outer `matchOffers` here holds the
 *      shared `nonReentrant` lock on diamond storage, so the
 *      internal entry point on OfferFacet must NOT also try to
 *      acquire it (double-acquire would deadlock); it relies on
 *      the outer lock for safety, which is the standard pattern
 *      across the codebase.
 */
contract OfferMatchFacet is DiamondReentrancyGuard, DiamondPausable {
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

    // ── Errors ──────────────────────────────────────────────────────
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

    /// @notice Range Orders Phase 1 — bot-facing preview of a candidate
    ///         (lender, borrower) match. Pure view; runs the validity
    ///         matrix (§4.1) + computes midpoint terms (§4.2) + the
    ///         synthetic HF check via `LibRiskMath`. Bots filter
    ///         candidate pairs against this before submitting
    ///         `matchOffers` to avoid paying for reverting txs.
    /// @return result Structured outcome — see `LibOfferMatch.MatchResult`.
    ///         `errorCode == Ok` means `matchOffers(lenderOfferId,
    ///         borrowerOfferId)` would succeed at this block; the
    ///         struct also carries the concrete (matchAmount,
    ///         matchRateBps, reqCollateral, lenderRemainingPostMatch)
    ///         values so the bot can estimate gain pre-submission.
    function previewMatch(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
        returns (LibOfferMatch.MatchResult memory result)
    {
        return LibOfferMatch.previewMatch(lenderOfferId, borrowerOfferId);
    }

    /// @notice Range Orders Phase 1 — match a lender offer against a
    ///         borrower offer. Permissionless; `msg.sender` is recorded
    ///         on the resulting loan as the matcher and receives the
    ///         LIF kickback (see `cfgLifMatcherFeeBps`) at terminal
    ///         (lender-asset path: at match via `_acceptOffer` LIF
    ///         split; VPFI path: at proper close / default via
    ///         `LibVPFIDiscount`).
    /// @dev    Gated on the `partialFillEnabled` master flag (default
    ///         off on a fresh deploy). When active, validates via
    ///         `LibOfferMatch.previewMatch`, sets the per-tx
    ///         `matchOverride` slot with midpoint terms + counterparty
    ///         + matcher addresses, calls into
    ///         `OfferFacet.acceptOfferInternal` (cross-facet) reusing
    ///         the existing vault + LIF + NFT + LoanFacet plumbing,
    ///         then increments the lender offer's `amountFilled` and
    ///         auto-closes on dust.
    ///         The borrower offer is single-fill in Phase 1 (per
    ///         design §10.1), so `_acceptOffer` flips its `accepted`
    ///         to true; the lender offer is preserved (storage stays)
    ///         when partial-filled, deleted when fully filled or
    ///         dust-closed.
    /// @return loanId  The newly initiated loan.
    function matchOffers(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) {
            // Master kill-switch: matching infra dormant until governance
            // enables it post-bake.
            revert FunctionDisabled(3);
        }

        // Pre-flight via the shared core; map structured errors into
        // typed reverts declared on this facet.
        LibOfferMatch.MatchResult memory mr =
            LibOfferMatch.previewMatch(lenderOfferId, borrowerOfferId);
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
            revert InvalidOfferType();
        }

        // ── State mutation: install the match override. See the
        // matching docstring on `OfferFacet._acceptOffer` for the
        // override-slot consumer side.
        LibVaipakam.MatchOverride storage mo = s.matchOverride;
        mo.amount = mr.matchAmount;
        mo.rateBps = mr.matchRateBps;
        mo.collateralAmount = mr.reqCollateral;
        mo.counterparty = s.offers[lenderOfferId].creator;
        mo.matcher = msg.sender;
        mo.active = true;

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

        // Clear the override now that the loan is initiated. Critical:
        // any subsequent same-tx initiateLoan calls (e.g., a follow-up
        // strategic flow) MUST fall through to the legacy field-read
        // path.
        delete s.matchOverride;

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
                if (bm.collateralAssetType == LibVaipakam.AssetType.ERC20) {
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
            // lifMatcherFee: paid synchronously inside `_acceptOffer`'s
            // LIF split (lender-asset path) or zero (VPFI path —
            // settles at terminal). Computed here for the event so
            // downstream indexers can render the matcher's earnings
            // without re-deriving from the LIF settings. Reads the
            // governance-tunable matcher BPS from cfg, not the
            // constant.
            (mr.matchAmount * LibVaipakam.cfgLoanInitiationFeeBps()
                * LibVaipakam.cfgLifMatcherFeeBps())
                / (LibVaipakam.BASIS_POINTS * LibVaipakam.BASIS_POINTS),
            borrowerEffFilled,
            bm.accepted
        );
    }
}
