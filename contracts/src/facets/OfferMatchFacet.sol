// src/facets/OfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OfferFacet} from "./OfferFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";

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
 *             executes the match: pulls escrowed assets, mints the
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
 *      escrow + NFT-mint + loan-init plumbing already in
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
    event OfferMatched(
        uint256 indexed lenderOfferId,
        uint256 indexed borrowerOfferId,
        uint256 indexed loanId,
        address matcher,
        uint256 matchAmount,
        uint256 matchRateBps,
        uint256 lenderRemainingPostMatch,
        uint256 lifMatcherFee
    );

    /// @dev Re-declared from OfferFacet for the same reason.
    enum OfferCloseReason { FullyFilled, Dust, Cancelled }
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
    error EscrowWithdrawFailed();

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
    ///         the existing escrow + LIF + NFT + LoanFacet plumbing,
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
                OfferFacet.acceptOfferInternal.selector,
                borrowerOfferId,
                /* acceptorFallbackConsent */ true,
                /* usePermit */ false
            ),
            // Surface a clear typed revert on cross-facet failure;
            // the inner revert reason still bubbles via the helper.
            EscrowWithdrawFailed.selector
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
        // The match locked `mr.reqCollateral` of collateral against
        // the loan, but the borrower may have posted MORE at offer-
        // create time (over-collateralized). Since borrower offers
        // are single-fill in Phase 1, the excess can never be reused
        // by another match — leaving it in escrow would trap the
        // funds. Refund to the borrower's wallet immediately so the
        // invariant "escrow only holds collateral committed to an
        // active offer or live loan" stays clean.
        //
        // ERC-20 collateral only: NFT collateral (ERC-721 / ERC-1155)
        // is whole-or-nothing — the borrower posts exactly the token
        // ids and quantity the offer references, so reqCollateral
        // always equals borrowerOffer.collateralAmount and there's
        // never overage to refund.
        {
            LibVaipakam.Offer storage B = s.offers[borrowerOfferId];
            if (
                B.collateralAssetType == LibVaipakam.AssetType.ERC20
                && B.collateralAmount > mr.reqCollateral
            ) {
                uint256 excess = B.collateralAmount - mr.reqCollateral;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        B.creator,           // pull from borrower's escrow
                        B.collateralAsset,
                        B.creator,           // refund to borrower's wallet
                        excess
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        }

        // ── Lender-side post-match accounting. The borrower offer is
        // already marked `accepted = true` by `_acceptOffer`. The
        // lender offer survives unless this match exhausted it.
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
                // lender's wallet. createOffer pre-escrowed amountMax;
                // _acceptOffer already pulled `mr.matchAmount` for the
                // borrower's principal, leaving `lenderRemaining` still
                // in custody. Lender ERC-20 only — NFT / ERC1155 lender
                // offers are single-fill (amount == amountMax) so this
                // branch is unreachable for them in practice.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        L.creator,
                        L.lendingAsset,
                        L.creator,
                        lenderRemaining
                    ),
                    EscrowWithdrawFailed.selector
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
                / (LibVaipakam.BASIS_POINTS * LibVaipakam.BASIS_POINTS)
        );
    }
}
