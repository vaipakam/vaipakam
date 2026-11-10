// src/facets/OfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable, LibPausable} from "../libraries/LibPausable.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {OfferPreviewFacet} from "./OfferPreviewFacet.sol";

/**
 * @title OfferMatchFacet
 * @author Vaipakam Developer Team
 * @notice Range Orders Phase 1 — bot-driven offer matching surface.
 *         Hosts the two entry points the keeper-bot consumes:
 *           - `previewMatch(L, B, matcher, initiator)` — pure preview that runs the
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
 *
 *      #1219 (S-4) — HOST SPLIT. `matchIntent` (the standing-intent fill the
 *      solver / backstop / adapter routes enter) lives in
 *      `OfferMatchIntentFacet` since the capacity gates landed: this facet
 *      sat 293 B under EIP-170, less than one cross-facet call, so the three
 *      fill gates could not inline here. The match-execution core both hosts
 *      share — `LibOfferMatchExecute.executeMatch`, with the events and
 *      errors it owns — is ONE library inlined by both: one source, two
 *      hosts. Same storage, same Diamond, same selectors for every caller;
 *      only the runtime bytecode is split.
 *
 *      #3443 — HOST SPLIT. `matchSignedOffer`, the keeper-matcher that fills
 *      a signed off-chain offer against an on-chain one, lives in
 *      `SignedOfferMatchFacet`: the offer-age rule put this facet over
 *      EIP-170, and the signed-offer fill is its own feature (signature,
 *      nonce and slice checks) on top of the same `executeMatch` core.
 */
contract OfferMatchFacet is DiamondReentrancyGuard, DiamondPausable {

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
    /// @param  matcher The account that would call `matchOffers`. Named, never
    ///         read from `msg.sender` (#2459 r2): an off-chain `eth_call` carries no
    ///         sender unless set, and the zero address's never-seen bucket always
    ///         reads covered, so a sender-keyed preview told an exhausted keeper
    ///         (and the app's matcher) that a doomed match would succeed.
    /// @param  initiator The transaction's originator — the account the charge
    ///         falls to when `matcher` is an aggregator adapter with no bound
    ///         operator (#2459 r4: the route's other input, named for the same
    ///         reason). For a matcher that sends its own transaction, the matcher.
    function previewMatch(uint256 lenderOfferId, uint256 borrowerOfferId, address matcher, address initiator)
        external
        view
        returns (LibOfferMatch.MatchResult memory result)
    {
        // #2812 — `matchOffers`'s entry guards first, in its order (the pause
        // modifier, the matcher's sanctions screen, the matching kill-switch),
        // so a match that would revert on one of them never previews `Ok`.
        if (LibPausable.paused()) {
            result.errorCode = LibOfferMatch.MatchError.Paused;
            return result;
        }
        if (LibVaipakam.isSanctionedAddress(matcher)) {
            result.errorCode = LibOfferMatch.MatchError.Sanctioned;
            return result;
        }
        if (!LibVaipakam.storageSlot().protocolCfg.partialFillEnabled) {
            result.errorCode = LibOfferMatch.MatchError.MatcherDisabled;
            return result;
        }
        result = LibOfferMatch.previewMatch(lenderOfferId, borrowerOfferId);
        // #1219 review — the match's capacity charge is its last step, so it is
        // this preview's last check, for the actor `matchOffers` would charge.
        if (
            result.errorCode == LibOfferMatch.MatchError.Ok
                && !LibServiceCapacity.fillCovered(LibVaipakam.storageSlot(), matcher, initiator)
        ) result.errorCode = LibOfferMatch.MatchError.CapacityExhausted;
        // #3025 — the loan the match opens is created from the borrower offer
        // at the matched amount, and creation re-admits its cadence after
        // every check above. Asked of the same entry creation calls.
        if (result.errorCode == LibOfferMatch.MatchError.Ok) {
            try OfferPreviewFacet(address(this)).requireOriginationCadenceAdmitted(
                borrowerOfferId, result.matchAmount
            ) {} catch {
                result.errorCode = LibOfferMatch.MatchError.CadenceNotAdmitted;
            }
        }
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
        // #494 Card A — Tier-1 sanctions gate on the matcher.
        // matchOffers pays the matcher a 1% LIF kickback (per the
        // range-orders design); paying a sanctioned matcher is the
        // exact thing the OFAC screen exists to prevent. The two
        // offer creators were already sanctions-checked at offer-
        // create time, so this single check covers the matcher.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) {
            // Master kill-switch: matching infra dormant until governance
            // enables it post-bake.
            revert LibOfferMatchExecute.FunctionDisabled(3);
        }

        // No borrower collateral floor: two on-chain offers each accepted
        // their own single-value / ranged collateral semantics at create time.
        loanId = LibOfferMatchExecute.executeMatch(lenderOfferId, borrowerOfferId, 0);
        // #1219 — one fill, charged LAST (a refused charge reverts the match whole)
        // to the actor the route names for the matcher (`LibServiceCapacity.routeActor`
        // — the same rule {previewMatch} checks, #2459 r4), so the preview reports it
        // as its last check.
        LibServiceCapacity.chargeSolver();
    }
}
