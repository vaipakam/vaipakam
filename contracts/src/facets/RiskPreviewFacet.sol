// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";

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
            // The slice-creator (lender) gate `_createOfferSetup` runs at 883 is
            // ALWAYS against the materialized SLICE's own assets — the intent's
            // lend / collateral legs (ERC-20, single-value; tokenIds 0 and prepay
            // immaterial to the ERC-20 pair key) — for BOTH a normal match and a
            // lender-sale vehicle. It is NOT the borrower offer's pair: for a
            // well-formed counterparty the two coincide, but a malformed / stale
            // one (asset-type mismatch => a post-gate `matchError`) has a
            // different, possibly riskier borrower pair (Codex #1115 r3); and for
            // a sale vehicle `_executeMatch` reverts `SaleVehicleNotMatchable`
            // before `assertMatchAllowed` ever gates the sold-loan pair, so the
            // sold-loan pair must not gate the pre-match lender either (Codex
            // #1115 r4). Hence: always the slice pair here.
            LibRiskAccess.PairId memory slicePair = LibRiskAccess.PairId({
                lendAsset: lendingAsset,
                lendType: LibVaipakam.AssetType.ERC20,
                lendTokenId: 0,
                collAsset: collateralAsset,
                collType: LibVaipakam.AssetType.ERC20,
                collTokenId: 0,
                prepayAsset: address(0)
            });
            uint8 rb = LibRiskAccess.previewActorBlock(s, actorA, slicePair);
            // The borrower gate (`assertMatchAllowed`) is reached live only after
            // the slice fully materializes (assets matched, not a sale vehicle),
            // so consult it — against the borrower/loan `pair` — only on a clean
            // result, never letting a borrower block override an earlier post-gate
            // failure.
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

    /**
     * @notice #1503 PR-E (design item 11) — whether `loanId` may admit a NEW
     *         lender by sale, as a single classification.
     *
     * @dev    Lives HERE rather than inlined into the sale facets: both
     *         `EarlyWithdrawalFacet` and `OfferAcceptFacet` were already at
     *         the EIP-170 ceiling and the guard pushed each ~650 bytes over
     *         it, and `RiskFacet` had too little headroom to take it. This
     *         facet already hosts the risk-domain assert/classify surface the
     *         mutating paths consult (`assertMatchAllowed`,
     *         `assertObligationTransferAllowed`), so it is the consistent
     *         home rather than merely the one with room.
     *
     *         Classifies rather than reverts so ONE selector serves both the
     *         reverting guard and the read-only preview; `LibSaleSolvency`
     *         maps the code onto the caller-side errors. An oracle that
     *         cannot price a position REVERTS out of here, which the guard
     *         treats as fail-closed and the preview as not-admissible.
     *
     * @return code 0 admissible;
     *         1 live health factor below the loan's own admission floor;
     *         2/3/4 inherited risk terms weaker than current — admission
     *         health floor, liquidation LTV, init-LTV cap respectively;
     *         5 live LTV above the cap a fresh admission would allow;
     *         6 a leg is not priceable today, so nothing below can be measured
     *         (#1655) — note this REFUSES, where the superseded
     *         snapshot-based carve-out returned 0 for the same shape, and that
     *         it refuses UNCONDITIONALLY: the progressive-risk-access consent
     *         ladder classifies assets by identity and depth, never by live
     *         priceability, so it cannot be deferred to here (Codex r8).
     * @return a The position's figure for the failing check (0 when code 0),
     *         except code 6, where it names the unpriceable leg — 0 collateral,
     *         1 principal — because a refusal for want of a measurement has no
     *         figure to report.
     * @return b The figure it is required to meet (0 when code 0, and 0 for
     *         code 6 for the same reason).
     */
    /**
     * @notice #1503 item 28 — the window a lender-position sale forfeits
     *         interest over, and what that comes to right now.
     *
     * @dev    The client's seller quote (`sellerEconomics` in the alpha02
     *         `loanLive` mirror) reproduces the facet's forfeiture algebra from
     *         public loan data. Since #1801 that algebra depends on the lender's
     *         paid-through mark, which lives in appended Diamond storage with no
     *         field on the loan struct — so without this view the mirror cannot
     *         be corrected from anything the client can read, and every seller
     *         surface would keep quoting the raw accrual and overstate the cost
     *         on a periodic loan (Codex #1801 r3 P2).
     *
     *         Both halves are returned deliberately. `forfeitFrom` lets a client
     *         mirror the algebra itself, which the picker needs in order to
     *         re-derive figures for hypothetical offers; `forfeitAccrued` is the
     *         contract's own number for the CURRENT block, which a receipt should
     *         show rather than recompute. They cannot disagree.
     *
     *         Reads nothing about a sale — it is a property of the position, so
     *         it answers for any Active loan whether or not one is listed. On a
     *         loan with no delivered periodic interest (including every loan
     *         predating #1801) `forfeitFrom` is simply the accrual origin.
     *
     * @param loanId The loan whose lender position would be sold.
     * @return forfeitFrom    Timestamp the forfeiture window opens at — the
     *                        point the current lender has been paid through, or
     *                        the interest-accrual origin when they have never been
     *                        paid. Callers should treat this as the ANSWER and not
     *                        re-derive it from the mark: the mark is honoured only
     *                        while the position is provably unchanged since it was
     *                        stamped (no principal movement, no frozen share), and
     *                        this returns the accrual origin wherever it is not.
     *                        A client mirroring the rule would keep crediting
     *                        sellers the Diamond had stopped crediting.
     * @return forfeitAccrued Interest accrued across that window as of this
     *                        block, at the LOAN's own rate. This is the figure
     *                        the seller absorbs, before the rate shortfall.
     */
    function sellerForfeitureWindow(uint256 loanId)
        external
        view
        returns (uint256 forfeitFrom, uint256 forfeitAccrued)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        forfeitFrom = LibEntitlement.forfeitureAccrualStart(
            loanId,
            LibVaipakam.interestAccrualStartOf(loan)
        );
        uint256 secs =
            block.timestamp > forfeitFrom ? block.timestamp - forfeitFrom : 0;
        forfeitAccrued = (loan.principal * loan.interestRateBps * secs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    function saleAdmission(uint256 loanId)
        external
        view
        returns (uint8 code, uint256 a, uint256 b)
    {
        LibVaipakam.Storage storage st = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = st.loans[loanId];

        // Liquidity is judged RIGHT NOW, the same way origination judges it —
        // `OracleFacet.checkLiquidity`, the live fail-closed classifier
        // `LoanFacet` calls before stamping a loan, and the one
        // `AddCollateralFacet` already consults rather than the snapshot when
        // admitting new value into a live loan.
        //
        // Deliberately NOT `loan.collateralLiquidity` / `loan.principalLiquidity`:
        // those are written once at origination and never refreshed, so they
        // describe the market as it was, not as it is. A snapshot saying
        // `Liquid` on a market that has since degraded would pass every check
        // below against prices the protocol no longer considers usable, and
        // never reach the illiquid branch at all (#1655). The same reasoning
        // `FeeEntitlementFacet` records for the offer-creation snapshot, one
        // level further out: the snapshot is right for the question it was
        // taken to answer, and this is a different question.
        //
        // The snapshots remain right for what they are FOR: the existing loan's
        // own lifecycle (`RiskFacet`, `RepayFacet`, the default and liquidation
        // routing) is governed by the bargain struck at origination, and a
        // market moving underneath it must not rewrite that. Sale admission is
        // the one question asked about today rather than about origination.
        // A leg is measurable only if BOTH sources say so, and that is not a
        // redundant belt: they answer different questions and each can block on
        // its own.
        //
        //   * The LIVE reading is whether the market can be priced today. Only
        //     it can catch a snapshot that has gone stale in the dangerous
        //     direction — still `Liquid` for a market that has degraded.
        //   * The SNAPSHOT is whether risk math is available for this loan AT
        //     ALL: `RiskFacet.calculateHealthFactor` gates on
        //     `loan.collateralLiquidity` / `loan.principalLiquidity` and reverts
        //     `IlliquidLoanNoRiskMath` when either is not `Liquid`. So a loan
        //     carrying an illiquid snapshot has no health factor to compare,
        //     whatever the market has since done.
        //
        // Requiring both is therefore the accurate statement of "the protocol
        // can produce a figure for this position", not an arbitrary ratchet.
        // Reading only the live value would send a stale-`Illiquid` loan into
        // the health read and surface an opaque `IlliquidLoanNoRiskMath` where
        // the honest answer is that the position is unpriceable.
        LibVaipakam.LiquidityStatus collLiq = _measurable(
            loan.collateralAsset,
            loan.collateralLiquidity
        );
        LibVaipakam.LiquidityStatus prinLiq = _measurable(
            loan.principalAsset,
            loan.principalLiquidity
        );
        if (
            collLiq != LibVaipakam.LiquidityStatus.Liquid ||
            prinLiq != LibVaipakam.LiquidityStatus.Liquid
        ) {
            // An unpriceable leg cannot be measured: health factor is a ratio
            // of oracle-priced values and REVERTS here rather than returning a
            // conservative number, so none of the checks below can run. This is
            // the design doc's Phase-1 exclusion for these positions
            // (`LenderEarlyWithdrawalUXDesign.md` 717-736), and the refusal is
            // UNCONDITIONAL — it does not consult the progressive-risk-access
            // switch.
            //
            // An earlier revision of this branch DID consult it, admitting
            // unpriceable positions when the gate was on so the buyer-consent
            // gate could decide. That was wrong, and the reason generalises
            // (Codex #1635 r8): **the consent ladder classifies assets, not
            // measurements.** `LibRiskAccess._isBlueChip` returns true for WETH
            // and every configured PAA asset by IDENTITY, with no liquidity
            // read, so `_assetRequiredLevel` yields `BlueChipOnly` — the level
            // every vault holds by default. A WETH leg whose ETH/numeraire feed
            // has gone stale, or whose sequencer check fails, is therefore
            // unpriceable AND still blue-chip: the gate requires no opt-up and
            // no pair consent, and would wave the position through to a
            // default-tier buyer on both sale paths.
            //
            // So the ladder cannot stand in for this check. It answers "how
            // risky is this class of asset", which is a property of the asset;
            // measurability is a property of the oracle's state right now, and
            // there is nothing for a buyer to consent to when the protocol
            // cannot say what the position is worth. Deferring to a gate on the
            // assumption that it recognises a condition it never reads is the
            // failure mode, not the switch itself.
            //
            // Refusing is not the "silent blocking" the design doc rules out:
            // that objection is to a guard that reverts without saying why.
            // This names the condition and the leg.
            return (
                6,
                collLiq != LibVaipakam.LiquidityStatus.Liquid ? 0 : 1,
                0
            );
        }

        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        uint256 floor = LibVaipakam.effectiveLoanMinHealthFactor(
            loan.minHealthFactorAtInit
        );
        if (hf < floor) return (1, hf, floor);

        // Inherited snapshots must be no WEAKER than a fresh loan's today.
        // Migrating the position changes the lender, not the loan's terms, so
        // without this the buyer can inherit a looser collateral-withdrawal
        // floor and a later liquidation point than they could be sold today.
        // One-directional on purpose: STRICTER than current is fine to sell.
        // BRANCH-AWARE, mirroring `LoanFacet._snapshotRiskCaps` exactly: the
        // depth-tiered regime admits at HF_LIQUIDATION_THRESHOLD (1e18) and
        // only the non-tiered regime uses the tunable knob. Comparing a
        // tiered-originated loan's 1e18 snapshot against the knob (>=1.2e18,
        // 1.5e18 by default) would classify EVERY such loan as weaker and
        // block it from both sale paths, which is a false positive rather
        // than a tightening.
        uint256 currentHf = LibVaipakam.cfgDepthTieredLtvEnabled()
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.minHealthFactor();
        if (floor < currentHf) return (2, floor, currentHf);

        uint8 effTier = _effectiveTierOrZero(loan.collateralAsset);

        uint256 curLiqLtv = LibVaipakam.cfgTierLiquidationLtvBps(effTier);
        if (uint256(loan.liquidationLtvBpsAtInit) > curLiqLtv) {
            return (3, uint256(loan.liquidationLtvBpsAtInit), curLiqLtv);
        }

        uint256 curCap = st.assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps;
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(effTier));
            if (tierCap < curCap) curCap = tierCap;
        }
        uint256 inheritedCap = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit,
            curCap
        );
        if (inheritedCap > curCap) return (4, inheritedCap, curCap);

        // The LIVE LTV, not just the cap snapshots. Equal caps say nothing
        // about where the position actually sits: accrued interest or
        // principal appreciation can carry a loan above its init cap while
        // the health factor stays above the floor. The tiered regime makes
        // that stark — floor 1e18, Tier-3 init cap 73%, liquidation
        // threshold 90% — so a position near 90% LTV would otherwise be
        // assignable even though `LoanFacet._checkInitialLtvAndHf` would
        // reject the same collateralisation as a fresh admission, which is
        // the standard a sale is meant to meet.
        //
        // Bound by `inheritedCap`, which the gate above has already proven
        // is the stricter of the two, so this satisfies both the loan's own
        // terms and today's.
        uint256 liveLtv = RiskFacet(address(this)).calculateLTV(loanId);
        if (liveLtv > inheritedCap) return (5, liveLtv, inheritedCap);

        return (0, 0, 0);
    }

    /// @dev Whether one leg is measurable for sale admission: `Liquid` only
    ///      when the live classification AND the loan's own snapshot both say
    ///      so. See the note in `saleAdmission` for why both are load-bearing.
    ///      Collapses to `Illiquid` — the refusing value — rather than
    ///      reporting which source objected, since the caller's answer is the
    ///      same either way and the leg index is what a consumer needs.
    function _measurable(
        address asset,
        LibVaipakam.LiquidityStatus snapshot
    ) private view returns (LibVaipakam.LiquidityStatus) {
        if (snapshot != LibVaipakam.LiquidityStatus.Liquid) {
            return LibVaipakam.LiquidityStatus.Illiquid;
        }
        return _liveLiquidity(asset);
    }

    /// @dev The live liquidity classification for one leg, read through the
    ///      same entry point `LoanFacet` uses at origination so the two agree
    ///      by construction rather than by inspection.
    ///
    ///      Degrades to `Illiquid` — the REFUSING value — when the call fails,
    ///      rather than bubbling. `checkLiquidity` reverts `InvalidAsset` only
    ///      for `address(0)`, which a live loan cannot carry (origination calls
    ///      this on both legs and would itself have reverted), so this is a
    ///      belt-and-braces path; if it is ever reached, an unanswerable
    ///      liquidity question must refuse the sale, never pass it. Note the
    ///      asymmetry with the health and LTV reads below, which are left to
    ///      revert: those are measurements of a position we have already
    ///      established is priceable, and a guard that cannot obtain one must
    ///      stop the sale loudly rather than convert it into a classification.
    function _liveLiquidity(address asset)
        private
        view
        returns (LibVaipakam.LiquidityStatus)
    {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset)
        );
        if (!ok || ret.length < 32) return LibVaipakam.LiquidityStatus.Illiquid;
        return abi.decode(ret, (LibVaipakam.LiquidityStatus));
    }

    /// @dev Mirrors `LoanFacet._snapshotRiskCaps`'s tier lookup, fallback and
    ///      all, so the comparison above is like-for-like with what would be
    ///      stamped on a loan originated right now.
    function _effectiveTierOrZero(address asset) private view returns (uint8) {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                asset
            )
        );
        return ok && ret.length >= 32 ? abi.decode(ret, (uint8)) : 0;
    }
}
