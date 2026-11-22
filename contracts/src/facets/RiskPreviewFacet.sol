// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {CollateralConcentrationFacet} from "./CollateralConcentrationFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {OfferPreviewFacet} from "./OfferPreviewFacet.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibInitRiskGate} from "../libraries/LibInitRiskGate.sol";

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
 *         #3843 — the sale side (`saleAdmission`, `quoteSellerBounds`,
 *         `getSaleListingBounds`) moved to `SaleAdmissionFacet` when this
 *         facet reached the EIP-170 ceiling. **Those reads are NOT here any
 *         more**; the two facets are refreshed together. The standing-intent
 *         fill preview (`previewIntent`, with the match core it inlines) moved
 *         to `IntentPreviewFacet` in the same change. **`previewIntent` is NOT
 *         here any more.** The match-actor resolver both facets use is
 *         `LibRiskAccess.resolveMatchActors`.
 *
 * @dev    Every function here is `external view`: it makes no state write,
 *         emits no event, and declares no local error. The gate DECISION logic
 *         lives entirely in `LibRiskAccess` (the match-actor resolution
 *         included); this facet is a thin selector/glue layer that owns the
 *         PairId construction the enforcing sites are too close to EIP-170 to
 *         inline. The two reverting asserts
 *         (`assertMatchAllowed`, `assertObligationTransferAllowed`) revert with
 *         `RiskTierTooLow` / `IlliquidPairNotConsented`, both declared in
 *         `LibRiskAccess` via `assertActorMayTransact` — not here.
 */
contract RiskPreviewFacet {
    /// @notice Non-reverting mirror of the accept-time risk gate for
    ///         `OfferAcceptFacet.previewAccept`'s dry-run (Codex #729 r3 finding
    ///         C; sale-offer handling r4): returns the FIRST failing block code.
    /// @return 0 = OK (or gate off), 1 = tier too low,
    ///         2 = illiquid pair needs a standing consent that is not yet
    ///             armed (record it, then wait the unlock cooldown),
    ///         3 = strict-mode mid-tier pair needs a fresh explicit ack (PR-2d).
    ///         Code 4 (the #735 "the accept acknowledgement will cover it" soft
    ///         warning) was retired by #3231 and is never returned.
    /// @dev    The WHOLE decision lives HERE, not in OfferAcceptFacet: that facet
    ///         sits at the EIP-170 ceiling, and the classification chain
    ///         (`previewActorBlock` → `_pairRequiredLevel` → `_isBlueChip` …) is
    ///         already linked into this preview facet. It even folds in the master-
    ///         switch so OfferAcceptFacet pays for a single staticcall and a
    ///         two-way branch. Builds the PairId the SAME way the matching accept
    ///         gate does so the preview and the gate classify identically.
    ///
    ///         Every party is read against STANDING consent only (#3231): the
    ///         gate no longer lets the acceptor's #662 accept acknowledgement
    ///         stand in for an illiquid pair consent, so there is no soft code
    ///         to model and the preview reports exactly what the gate enforces.
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
        // acceptor, both against standing consent (#3231).
        uint8 creatorBlock =
            LibRiskAccess.previewActorBlock(s, s.offers[offerId].creator, pair);
        if (creatorBlock != 0) return creatorBlock;
        return LibRiskAccess.previewActorBlock(s, acceptor, pair);
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

    /// @notice #3577 — the risk-access gate a FILL of the signed order `o` by
    ///         `acceptor` faces, before the order is stored. The stored-offer
    ///         previews ({previewOfferAcceptBlock}, {previewCreatorBlock},
    ///         {acceptMidTierAckPair}) are keyed on an offer id, which a signed
    ///         order has only once its fill creates the offer, in the same
    ///         transaction that is gated.
    /// @return creatorBlock  The signer's block code (the fill re-gates the
    ///         order's creator first).
    /// @return acceptorBlock The taker's block code. Reported separately from
    ///         the signer's because the taker can clear only their own.
    /// @return pair  The pair both are gated against, so the app can record a
    ///         strict-mode mid-tier acknowledgement for the right pair.
    /// @dev    Same codes as {previewOfferAcceptBlock}: 0 = OK or gate off,
    ///         1 = tier too low, 2 = illiquid pair needs an armed standing
    ///         consent, 3 = strict-mode mid-tier pair needs a fresh ack. Every
    ///         party is read against standing consent only (#3231).
    ///
    ///         A signed order is never a lender-sale vehicle (only
    ///         `EarlyWithdrawalFacet` links a sale offer, and only to an offer
    ///         it stores itself), so the fill gates both parties against the
    ///         order's OWN legs, as a normal stored offer is gated
    ///         ({_ownLegsPair}). Neither the signature, the order's shape nor
    ///         its funding is checked here: `OfferPreviewFacet.
    ///         previewSignedOfferAccept` answers those, and an order it refuses
    ///         never reaches the gate.
    function previewSignedOfferRiskBlocks(LibSignedOffer.SignedOffer calldata o, address acceptor)
        external
        view
        returns (uint8 creatorBlock, uint8 acceptorBlock, LibRiskAccess.PairId memory pair)
    {
        pair = _ownLegsPair(
            o.lendingAsset,
            LibVaipakam.AssetType(o.assetType),
            o.tokenId,
            o.collateralAsset,
            LibVaipakam.AssetType(o.collateralAssetType),
            o.collateralTokenId,
            o.prepayAsset
        );
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return (0, 0, pair);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        creatorBlock = LibRiskAccess.previewActorBlock(s, o.signer, pair);
        acceptorBlock = LibRiskAccess.previewActorBlock(s, acceptor, pair);
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
    /// @dev    Cross-facet entrypoint consumed by `LibOfferMatchExecute.executeMatch`
    ///         (which is near the EIP-170 ceiling, so the classifier lives here).
    ///         The gated parties + pair come from {LibRiskAccess.resolveMatchActors}: a normal
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
        ) = LibRiskAccess.resolveMatchActors(s, s.offers[lenderOfferId].creator, borrowerOfferId);
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
        ) = LibRiskAccess.resolveMatchActors(s, s.offers[lenderOfferId].creator, borrowerOfferId);
        uint8 a = LibRiskAccess.previewActorBlock(s, actorA, pair);
        if (a != 0) return a;
        if (actorB != address(0)) {
            return LibRiskAccess.previewActorBlock(s, actorB, pair);
        }
        return 0;
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
        return _ownLegsPair(
            o.lendingAsset, o.assetType, o.tokenId, o.collateralAsset, o.collateralAssetType, o.collateralTokenId,
            o.prepayAsset
        );
    }

    /// @dev The pair an offer that is not a lender-sale vehicle is gated
    ///      against: its own legs. One builder for a stored offer
    ///      ({_acceptGatePair}) and a signed order not yet stored
    ///      ({previewSignedOfferRiskBlocks}), so the two cannot classify the
    ///      same terms differently.
    function _ownLegsPair(
        address lendAsset,
        LibVaipakam.AssetType lendType,
        uint256 lendTokenId,
        address collAsset,
        LibVaipakam.AssetType collType,
        uint256 collTokenId,
        address prepayAsset
    ) private pure returns (LibRiskAccess.PairId memory) {
        return LibRiskAccess.PairId({
            lendAsset: lendAsset,
            lendType: lendType,
            lendTokenId: lendTokenId,
            collAsset: collAsset,
            collType: collType,
            collTokenId: collTokenId,
            prepayAsset: prepayAsset
        });
    }

    /**
     * @notice #3326 — the initiation risk gate's bounds for an ERC-20 loan of
     *         `lendingAsset` against `collateralAsset`, read live: the
     *         collateral the gate requires for `amount`, whether the
     *         depth-tiered regime set that floor, and the largest principal
     *         `collateral` supports under it (the inverse, rounded so any
     *         amount at or below it passes). When the gate does not apply to
     *         the pair (an illiquid leg), the floor is 0 and the cap is
     *         unbounded.
     * @dev The ONE host of the match core's risk bounds. Hosted here since
     *      #3328 (it was on OfferPreviewFacet, which reached EIP-170): it is a
     *      risk read, beside the other origination risk previews. The match core
     *      ({LibOfferMatch}) is compiled into four facets; it asks here by
     *      self-call so the rule, and its bytecode, live once. Under
     *      depth-tiered LTV the cap is min(per-asset init-LTV ceiling, the
     *      collateral tier's cap), as `LibNewLoanRisk.requireAdmissible`
     *      applies it; a Tier-0 collateral caps at 0, so the floor is
     *      `type(uint256).max` and the cap 0. Otherwise the floor is the
     *      HF admission floor. Reverts when a liquid leg has no usable price
     *      (#2419), as the binding gate does.
     */
    function initRiskBounds(address lendingAsset, address collateralAsset, uint256 amount, uint256 collateral)
        external
        view
        returns (uint256 floor, bool tiered, uint256 amountCap)
    {
        if (!LibInitRiskGate.applies(
            OracleFacet(address(this)).checkLiquidity(lendingAsset),
            OracleFacet(address(this)).checkLiquidity(collateralAsset)
        )) return (0, false, type(uint256).max);
        tiered = LibVaipakam.cfgDepthTieredLtvEnabled();
        if (tiered) {
            // #3685 — the one host of the new-loan cap (tier, asset ceiling
            // and the concentration step), as loan creation reads it.
            (uint256 capBps,,,) = CollateralConcentrationFacet(address(this)).newLoanInitLtvCapBps(collateralAsset);
            floor = LibRiskMath.minCollateralForLtvCap(amount, lendingAsset, collateralAsset, capBps);
            amountCap = LibRiskMath.maxLendingForLtvCap(collateral, lendingAsset, collateralAsset, capBps);
        } else {
            floor = LibRiskMath.minCollateralForLending(amount, lendingAsset, collateralAsset);
            amountCap = LibRiskMath.maxLendingForCollateral(collateral, lendingAsset, collateralAsset);
        }
    }
}
