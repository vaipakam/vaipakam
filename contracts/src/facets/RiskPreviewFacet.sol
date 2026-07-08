// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";

/**
 * @title RiskPreviewFacet
 * @author Vaipakam Developer Team
 * @notice Read-only risk-access previews + the two cross-facet gate asserts,
 *         split out of `RiskAccessFacet` (#1104). RiskAccessFacet owns the
 *         per-vault WRITE surface (tier / consent / strict-mode setters,
 *         terms-version admin levers) and stayed at the EIP-170 ceiling; this
 *         facet carries the pure `view` preview cluster the dapp / keeper bots
 *         read and the two `view` gate asserts that enforcing facets
 *         (`OfferMatchFacet`, `PrecloseFacet`) cross-call — freeing header
 *         room on both facets for future work.
 *
 * @dev    Every function here is `external view`: it makes no state write,
 *         emits no event, and declares no local error. The gate DECISION logic
 *         lives entirely in `LibRiskAccess` (+ `LibOfferMatch` for the intent
 *         preview); this facet is a thin selector/glue layer that owns the
 *         actor-resolution + PairId construction the enforcing sites are too
 *         close to EIP-170 to inline. The two reverting asserts
 *         (`assertMatchAllowed`, `assertObligationTransferAllowed`) revert with
 *         `RiskTierTooLow` / `IlliquidPairNotConsented`, both declared in
 *         `LibRiskAccess` via `assertActorMayTransact` — not here.
 */
contract RiskPreviewFacet {
    /// @notice Non-reverting mirror of the accept-time risk gate for
    ///         `OfferAcceptFacet.previewAccept`'s dry-run (Codex #729 r3 finding
    ///         C; sale-offer handling r4): returns the FIRST failing block code.
    /// @return 0 = OK (or gate off), 1 = tier too low,
    ///         2 = illiquid pair needs standing consent (the acceptor's #662 ack
    ///             cannot cover it — a creator-side gap, a rental-prepay / derived-
    ///             tier-0 leg, or a stale tier anchor),
    ///         3 = strict-mode mid-tier pair needs a fresh explicit ack (PR-2d),
    ///         4 = #735 — illiquid pair, but the ACCEPTOR's standard #662
    ///             acknowledgement (always produced by the accept-signing flow)
    ///             WILL clear it at sign-time; a SOFT warning the dapp proceeds
    ///             past, NOT a hard block.
    /// @dev    The WHOLE decision lives HERE, not in OfferAcceptFacet: that facet
    ///         sits at the EIP-170 ceiling, and the classification chain
    ///         (`previewActorBlock` → `_pairRequiredLevel` → `_isBlueChip` …) is
    ///         already linked into this preview facet. It even folds in the master-
    ///         switch so OfferAcceptFacet pays for a single staticcall and a
    ///         two-way branch. Builds the PairId the SAME way the matching accept
    ///         gate does so the preview and the gate classify identically.
    ///
    ///         #735 item 1 — the ACCEPTOR leg is evaluated ack-AWARE
    ///         (`previewAcceptorBlockAckAware`): an accept always carries the
    ///         acceptor's #662 ack, so modeling it lets the dapp soft-warn (code 4)
    ///         on the common illiquid-accept the ack self-heals instead of hard-
    ///         blocking every illiquid pair. The CREATOR leg stays standing-consent
    ///         only (it authors no accept ack — see `previewActorBlock`), and the
    ///         lender-sale-vehicle branch stays conservative (the buyer's #662 ack
    ///         is derived from the sale offer, not the linked loan's pair, so
    ///         softening it is out of scope here — never a false soften).
    ///
    ///         Two shapes (mirroring `LoanFacet._maybeRunInitialRiskGates`):
    ///          - **lender-sale vehicle** (`saleOfferToLoanId[offerId] != 0`): the
    ///            accept gates only the BUYER (the `acceptor`) against the LINKED
    ///            loan's pair — the exiting seller is exempt — so the preview does
    ///            the same (Codex #729 r4: NOT a blanket `return 0`, which would
    ///            quote an under-tiered sale buyer as OK);
    ///          - **normal offer**: the creator (re-gated at accept) then the
    ///            acceptor against the offer's own pair.
    function previewOfferAcceptBlock(uint256 offerId, address acceptor)
        external
        view
        returns (uint8)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return 0;
        LibRiskAccess.PairId memory pair = _acceptGatePair(s, offerId);
        if (s.saleOfferToLoanId[offerId] != 0) {
            // Sale vehicle: only the BUYER (`acceptor`) is gated, against the sold
            // loan's pair (the exiting seller is exempt — Codex #729 r4).
            return LibRiskAccess.previewActorBlock(s, acceptor, pair);
        }
        // Normal offer: the creator is re-gated against the LIVE state, then the
        // acceptor — ack-aware (#735 item 1): an accept always carries the
        // acceptor's #662 ack, so an illiquid pair the ack self-heals reports code
        // 4 (soft) instead of code 2 (hard).
        uint8 creatorBlock =
            LibRiskAccess.previewActorBlock(s, s.offers[offerId].creator, pair);
        if (creatorBlock != 0) return creatorBlock;
        return LibRiskAccess.previewAcceptorBlockAckAware(s, acceptor, pair);
    }

    /// @notice #735 item 3 — the risk-gate block code the OFFER CREATOR faces for
    ///         their OWN posted `offerId`, so the dapp can offer an in-flow
    ///         acknowledgement / tier prompt on the creator's own offers (the
    ///         accept gate re-checks the creator first). Same codes as
    ///         {previewOfferAcceptBlock} (0 = OK/gate-off, 1 = tier too low,
    ///         2 = illiquid pair needs consent, 3 = strict-mode mid-tier ack).
    /// @dev    A lender-sale vehicle's creator is the EXITING SELLER, who is exempt
    ///         from the accept-time gate (only the buyer is checked), so this
    ///         returns 0 for a sale vehicle — the dapp must not prompt a seller to
    ///         record an acknowledgement acceptors never need (Codex #740 r7).
    ///         Standing-consent semantics: the creator authors no accept ack.
    function previewCreatorBlock(uint256 offerId)
        external
        view
        returns (uint8)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return 0;
        if (s.saleOfferToLoanId[offerId] != 0) return 0; // exiting seller is exempt
        return LibRiskAccess.previewActorBlock(
            s, s.offers[offerId].creator, _acceptGatePair(s, offerId)
        );
    }

    /// @notice #735 item 3 — the exact risk-access `PairId` that an ACCEPT of
    ///         `offerId` is gated against, so the dapp can record a strict-mode
    ///         mid-tier acknowledgement (`setMidTierPairAck`) for the RIGHT pair.
    /// @dev    A lender-sale vehicle gates the buyer against the SOLD LOAN's pair,
    ///         NOT the sale offer's own asset surface — the dapp can't read the
    ///         internal `saleOfferToLoanId` mapping, so this resolves it on-chain
    ///         via the SAME {_acceptGatePair} the accept preview uses (they can't
    ///         disagree). For a normal offer it returns the offer's own pair.
    function acceptMidTierAckPair(uint256 offerId)
        external
        view
        returns (LibRiskAccess.PairId memory)
    {
        return _acceptGatePair(LibVaipakam.storageSlot(), offerId);
    }

    /// @notice #671 phase 2 (#728 PR-2c) — assert the INCOMING borrower of a
    ///         Preclose Option-2 obligation transfer may take on the resulting
    ///         loan's pair. Reverts `RiskTierTooLow` / `IlliquidPairNotConsented`
    ///         (from `LibRiskAccess`) when the incoming borrower's live vault tier
    ///         or standing illiquid-pair consent does not cover the position he
    ///         is assuming; no-op when the gate is off. Standing consent only —
    ///         this is not an accept flow, so there is no #662 acknowledgement to
    ///         substitute.
    /// @dev    A cross-facet entrypoint consumed by `PrecloseFacet.
    ///         transferObligationViaOffer`. PrecloseFacet sits at the EIP-170
    ///         ceiling, so the PairId construction lives here rather than inline
    ///         in that facet. The gated party is the offer's creator (the new
    ///         borrower the transfer installs). The pair is the POST-TRANSFER
    ///         loan: the lend leg stays the loan's principal, but the collateral
    ///         leg is taken from the BORROWER OFFER — `transferObligationViaOffer`
    ///         reassigns `loan.collateralTokenId = offer.collateralTokenId`, and
    ///         `assertAssetContinuity` pins the collateral asset/type/prepay but
    ///         NOT the token id, so an NFT-collateral transfer can install a
    ///         DIFFERENT token id than the loan currently holds. Classifying off
    ///         the offer's collateral id keeps the illiquid-pair consent key bound
    ///         to the collateral the new borrower actually backs. Reads-only +
    ///         reverts; safe to call via the diamond fallback from the
    ///         (non-reentrant) transfer flow.
    /// @param loanId The loan whose obligation is being transferred.
    /// @param borrowerOfferId The borrower offer being consumed; its creator is
    ///        the incoming borrower and its collateral leg is what backs the loan.
    function assertObligationTransferAllowed(
        uint256 loanId,
        uint256 borrowerOfferId
    ) external view {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        LibRiskAccess.assertActorMayTransact(
            s,
            offer.creator,
            LibRiskAccess.PairId({
                lendAsset: loan.principalAsset,
                lendType: loan.assetType,
                lendTokenId: loan.tokenId,
                collAsset: offer.collateralAsset,
                collType: offer.collateralAssetType,
                collTokenId: offer.collateralTokenId,
                prepayAsset: offer.prepayAsset
            })
        );
    }

    /// @notice #671 phase 2 (#728 PR-2b) — assert a keeper match's risk-access.
    ///         Reverts `RiskTierTooLow` / `IlliquidPairNotConsented` when a gated
    ///         party's live tier / standing consent doesn't cover the resulting
    ///         loan's pair; no-op when the gate is off. Standing consent only —
    ///         a keeper match authors no #662 acknowledgement to substitute.
    /// @dev    Cross-facet entrypoint consumed by `OfferMatchFacet._executeMatch`
    ///         (which is near the EIP-170 ceiling, so the classifier lives here).
    ///         The gated parties + pair come from {_resolveMatchActors}: a normal
    ///         match gates BOTH creators against the borrower offer's pair; a
    ///         lender-sale vehicle exempts the exiting seller and gates only the
    ///         buyer against the linked loan's pair.
    function assertMatchAllowed(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
    {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (
            address actorA,
            address actorB,
            LibRiskAccess.PairId memory pair
        ) = _resolveMatchActors(s, s.offers[lenderOfferId].creator, borrowerOfferId);
        LibRiskAccess.assertActorMayTransact(s, actorA, pair);
        if (actorB != address(0)) {
            LibRiskAccess.assertActorMayTransact(s, actorB, pair);
        }
    }

    /// @notice #671 phase 2 (#728 PR-2b) — NON-reverting risk preview for a
    ///         candidate keeper match, so a bot can filter a pair the gate would
    ///         reject instead of burning gas on a reverting `matchOffers`.
    ///         Returns 0 = OK, 1 = a gated party's tier is too low, 2 = an
    ///         illiquid pair lacks standing consent, 3 = a strict-mode mid-tier
    ///         pair needs a fresh explicit ack (same codes as
    ///         {previewOfferAcceptBlock}). 0 when the gate is off. The block of
    ///         the FIRST failing gated party (buyer/lender side first) is
    ///         reported.
    function previewMatchRiskBlock(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
        returns (uint8)
    {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return 0;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (
            address actorA,
            address actorB,
            LibRiskAccess.PairId memory pair
        ) = _resolveMatchActors(s, s.offers[lenderOfferId].creator, borrowerOfferId);
        uint8 a = LibRiskAccess.previewActorBlock(s, actorA, pair);
        if (a != 0) return a;
        if (actorB != address(0)) {
            return LibRiskAccess.previewActorBlock(s, actorB, pair);
        }
        return 0;
    }

    /// @notice #625 WI-2b — non-mutating preview of a `matchIntent` fill. A
    ///         keeper calls this BEFORE submitting `matchIntent` to learn,
    ///         off-chain and gas-free, whether the fill would succeed and — if
    ///         not — the exact first reason it would revert. On success it also
    ///         returns the principal / midpoint rate / required collateral the
    ///         fill would lock, so a solver can size the call from one read.
    /// @dev    The intent-level guards + the shared match-admission core run in
    ///         {LibOfferMatch.previewIntent}; this wrapper layers the #671
    ///         risk-access gate on top (it owns the actor resolver), exactly as
    ///         `OfferMatchFacet._executeMatch` calls {assertMatchAllowed} after
    ///         `previewMatch`. The binding guarantee that this preview agrees
    ///         with the live fill is the `previewIntent` Ok ⟺ `matchIntent`
    ///         succeeds agreement test (`LenderIntentPreview.t.sol`).
    /// @param  solver  Prospective filler — `requiresKeeperAuth` is checked
    ///         against THIS address, not this view's `msg.sender`, so a keeper
    ///         can preview on behalf of the account that would submit.
    /// @param  lender  Intent owner (slice creator).
    /// @param  lendingAsset / collateralAsset  Intent key.
    /// @param  counterpartyOfferId  The stored borrower offer to fill against.
    /// @param  fillAmount  Principal the solver intends to lend this fill.
    function previewIntent(
        address solver,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external view returns (LibOfferMatch.IntentPreviewResult memory res) {
        res = LibOfferMatch.previewIntent(
            solver,
            lender,
            lendingAsset,
            collateralAsset,
            counterpartyOfferId,
            fillAmount
        );
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Live order in `_executeMatch` (Codex #1115 r2): the intent-level guards
        // and the slice's duration-cap + per-asset pause run BEFORE
        // `_createOfferSetup`'s SLICE-CREATOR (lender) risk gate
        // (`assertActorMayTransact`, gate-on only); the collateral floor, the
        // >365d cadence bound, the sale-vehicle rejection, and the match core all
        // run AFTER it; and the BORROWER-side `assertMatchAllowed` runs only once
        // the slice has fully materialized. So the reported first reason must be:
        //   • a PRE-gate failure (intent-level, slice duration-cap, slice pause)
        //     as-is — the risk gate is never reached live;
        //   • otherwise the SLICE-CREATOR (lender) risk block if it trips, since
        //     it precedes every post-gate failure (floor / multi-year /
        //     sale-vehicle / match-core) live;
        //   • else the surviving post-gate failure, or (on a clean result) the
        //     BORROWER risk block, then the accept gates.
        // The post-gate `intentError` set is exactly {SliceCollateralBelowFloor,
        // SliceMultiYearTerm, SaleVehicleTagged}; any `matchError` is post-gate
        // too (the match core runs after materialization).
        bool precedesLenderRisk = !res.ok
            && res.matchError == LibOfferMatch.MatchError.Ok
            && res.intentError != LibOfferMatch.IntentError.SliceCollateralBelowFloor
            && res.intentError != LibOfferMatch.IntentError.SliceMultiYearTerm
            && res.intentError != LibOfferMatch.IntentError.SaleVehicleTagged;
        if (precedesLenderRisk) return res;

        // #671 risk-access gate. Resolve the gated parties via the slice's
        // CREATOR (= `lender`; the slice has no offer id) and the borrower offer;
        // handles the lender-sale-vehicle branch identically to the enforcing
        // path.
        if (LibVaipakam.cfgRiskAccessGateEnabled()) {
            (
                address actorA,
                address actorB,
                LibRiskAccess.PairId memory pair
            ) = _resolveMatchActors(s, lender, counterpartyOfferId);
            // Slice-creator (lender) gate — the one `_createOfferSetup` runs
            // before the post-gate failures above.
            uint8 rb = LibRiskAccess.previewActorBlock(s, actorA, pair);
            // Borrower gate (`assertMatchAllowed`) is reached live only after the
            // slice fully materializes, so consult it only on a clean result —
            // never let a borrower block override an earlier post-gate failure.
            if (rb == 0 && res.ok && actorB != address(0)) {
                rb = LibRiskAccess.previewActorBlock(s, actorB, pair);
            }
            res.riskBlock = rb;
            if (rb != 0) {
                // The risk gate is the live first-revert reason here; clear any
                // stale post-gate failure code so consumers keying on
                // intentError / matchError don't report the later reason.
                res.ok = false;
                res.intentError = LibOfferMatch.IntentError.Ok;
                res.matchError = LibOfferMatch.MatchError.Ok;
                return res;
            }
        }

        // Risk gate cleared (or off): a surviving post-gate failure is now the
        // correct first reason (its live check comes after the passed risk gate).
        if (!res.ok) return res;

        // #747 Codex r1/r2/r3 — accept-time gates. After the match + risk gate
        // the live fill enters `acceptOfferInternal(counterpartyOfferId)` with
        // the lender slice as acceptor, which can still reject on gates a
        // borrower newly trips AFTER posting. Reproduce the gates that can fail
        // on this deploy:
        //   - sanctions on the borrower (offer creator);
        //   - `offerConsumedBySale` — the terminal bit a Scenario-A parallel
        //     sale sets, which `_acceptOffer` rejects with `OfferConsumedBySale`
        //     even while the row still looks matchable (Codex r2);
        //   - KYC, when governance has enabled enforcement (Codex r3). Reuse the
        //     SAME value + predicate the accept path applies: the #627 public
        //     `calculateTransactionValueNumeraire` (effectivePrincipal for a
        //     match == the matched amount) and `ProfileFacet.meetsKYCRequirement`
        //     for BOTH the borrower (offer creator) and the lender (acceptor).
        //     Gated on the flag so retail (enforcement off) pays no oracle read;
        //     `meetsKYCRequirement` itself also short-circuits true when off.
        // (Per-asset pause is mirrored EARLIER at the slice-materialization
        // stage, matching the live order. Country-pair is compile-time pure-true
        // on the retail deploy — the gated variant is a separate industrial-fork
        // function — so it can never block here. Already-accepted / expired are
        // covered by the match core.)
        bool kycBlocked;
        if (s.kycEnforcementEnabled) {
            uint256 valueNumeraire = OfferAcceptFacet(address(this))
                .calculateTransactionValueNumeraire(
                    counterpartyOfferId, res.matchAmount
                );
            kycBlocked =
                !ProfileFacet(address(this)).meetsKYCRequirement(
                    s.offers[counterpartyOfferId].creator, valueNumeraire
                )
                || !ProfileFacet(address(this)).meetsKYCRequirement(
                    lender, valueNumeraire
                );
        }
        if (
            LibVaipakam.isSanctionedAddress(s.offers[counterpartyOfferId].creator)
            || s.offerConsumedBySale[counterpartyOfferId]
            || kycBlocked
        ) {
            res.intentError = LibOfferMatch.IntentError.AcceptGateBlocked;
            res.ok = false;
        }
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev The asset pair an ACCEPT of `offerId` gates against — the single source
    ///      shared by {previewOfferAcceptBlock} and {acceptMidTierAckPair}. A
    ///      lender-sale vehicle (`saleOfferToLoanId[offerId] != 0`) gates against
    ///      the LINKED loan's pair (the position the buyer joins); a normal offer
    ///      against its own surface.
    function _acceptGatePair(LibVaipakam.Storage storage s, uint256 offerId)
        private
        view
        returns (LibRiskAccess.PairId memory)
    {
        uint256 saleLoanId = s.saleOfferToLoanId[offerId];
        if (saleLoanId != 0) {
            LibVaipakam.Loan storage sold = s.loans[saleLoanId];
            return LibRiskAccess.PairId({
                lendAsset: sold.principalAsset,
                lendType: sold.assetType,
                lendTokenId: sold.tokenId,
                collAsset: sold.collateralAsset,
                collType: sold.collateralAssetType,
                collTokenId: sold.collateralTokenId,
                prepayAsset: sold.prepayAsset
            });
        }
        LibVaipakam.Offer storage o = s.offers[offerId];
        return LibRiskAccess.PairId({
            lendAsset: o.lendingAsset,
            lendType: o.assetType,
            lendTokenId: o.tokenId,
            collAsset: o.collateralAsset,
            collType: o.collateralAssetType,
            collTokenId: o.collateralTokenId,
            prepayAsset: o.prepayAsset
        });
    }

    /// @dev Resolve the gated parties + the pair they are gated against for a
    ///      keeper match — the single source of truth shared by the enforcing
    ///      {assertMatchAllowed} and the non-reverting {previewMatchRiskBlock}.
    ///      `actorA` is always gated; `actorB` is gated only when non-zero.
    ///
    ///      NORMAL match: `_executeMatch` calls `acceptOfferInternal(borrowerOfferId)`,
    ///      so the resulting loan copies its `tokenId` / `collateralTokenId` /
    ///      `prepayAsset` from the BORROWER offer (the match-time asset check pins
    ///      only the asset contracts + types, not those ids). Both creators are
    ///      therefore gated against the BORROWER offer's pair — the actual loan —
    ///      so the lender consents to the pair it joins, not its own offer's
    ///      possibly-different one. actorA = lender-offer creator, actorB =
    ///      borrower-offer creator.
    ///
    ///      LENDER-SALE vehicle (borrower offer linked via `saleOfferToLoanId`):
    ///      the exiting seller (borrower-offer creator) is EXEMPT — that risk was
    ///      accepted at the original loan — and only the BUYER (the lender-offer
    ///      creator, who acquires the sold lender position) is gated, against the
    ///      LINKED loan's pair. Mirrors `LoanFacet._maybeRunInitialRiskGates`'s
    ///      sale-vehicle branch + the PR-2a sale-buyer treatment. actorA = buyer,
    ///      actorB = address(0).
    /// @dev The lender leg is passed as a CREATOR ADDRESS (not an offer id) so
    ///      this same resolver serves a #625 auto-lend intent slice, which is
    ///      never stored as an offer and so has no id to look up — only its
    ///      `creator` (the intent owner) is needed here. The id-based callers
    ///      pass `s.offers[lenderOfferId].creator`.
    function _resolveMatchActors(
        LibVaipakam.Storage storage s,
        address lenderCreator,
        uint256 borrowerOfferId
    )
        private
        view
        returns (address actorA, address actorB, LibRiskAccess.PairId memory pair)
    {
        uint256 soldLoanId = s.saleOfferToLoanId[borrowerOfferId];
        if (soldLoanId != 0) {
            LibVaipakam.Loan storage sold = s.loans[soldLoanId];
            actorA = lenderCreator; // buyer (incoming lender)
            actorB = address(0); // seller exempt
            pair = LibRiskAccess.PairId({
                lendAsset: sold.principalAsset,
                lendType: sold.assetType,
                lendTokenId: sold.tokenId,
                collAsset: sold.collateralAsset,
                collType: sold.collateralAssetType,
                collTokenId: sold.collateralTokenId,
                prepayAsset: sold.prepayAsset
            });
            return (actorA, actorB, pair);
        }
        LibVaipakam.Offer storage bo = s.offers[borrowerOfferId];
        actorA = lenderCreator;
        actorB = bo.creator;
        pair = LibRiskAccess.PairId({
            lendAsset: bo.lendingAsset,
            lendType: bo.assetType,
            lendTokenId: bo.tokenId,
            collAsset: bo.collateralAsset,
            collType: bo.collateralAssetType,
            collTokenId: bo.collateralTokenId,
            prepayAsset: bo.prepayAsset
        });
    }
}
