// src/facets/OfferPreviewFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibSaleSolvency} from "../libraries/LibSaleSolvency.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";

/**
 * @title OfferPreviewFacet
 * @author Vaipakam Developer Team
 * @notice #980 — the read-only accept-preview surface, extracted out of
 *         `OfferAcceptFacet`. That facet was chronically at the EIP-170
 *         24,576-byte runtime ceiling, so any further behaviour on the accept
 *         path (e.g. #951 v2's live-binding) overflowed it. Moving the large,
 *         self-contained `previewAccept` view here frees ~2.5 KB and cleanly
 *         separates the preview/classification surface from the state-mutating
 *         accept surface.
 * @dev Part of the Diamond Standard (EIP-2535). Pure view facet — no
 *      reentrancy/pausable base needed. The `AcceptPreview` struct and
 *      `AcceptError` enum stay defined on `OfferAcceptFacet` (their ABI home is
 *      unchanged, so consumers keep referencing `OfferAcceptFacet.AcceptPreview`
 *      / `.AcceptError`); this facet returns and populates those qualified
 *      types. The KYC numeraire value is read via the PUBLIC
 *      `OfferAcceptFacet.calculateTransactionValueNumeraire` cross-facet view
 *      (the same one `RiskAccessFacet`/the aggregator adapter use) rather than
 *      the private `_calculateTransactionValueNumeraire`, which stays on
 *      OfferAcceptFacet next to `_acceptOffer`.
 */
contract OfferPreviewFacet {
    /// @notice The offer does not exist (zero creator).
    error InvalidOffer();

    /**
     * @notice Read-only projection + first-failing-blocker for a direct
     *         `acceptOffer(offerId)` by `acceptor`. Mirrors `_acceptOffer`'s
     *         precondition order so the frontend can explain (and pre-empt) a
     *         revert, and carries the projected principal / rate / collateral /
     *         residual-refund / LIF estimate for quoting.
     * @dev Moved verbatim from `OfferAcceptFacet.previewAccept` (#980); the only
     *      change is the KYC value read (now the public cross-facet view). The
     *      risk-access gate is still surfaced separately via
     *      `RiskPreviewFacet.previewOfferAcceptBlock`, which the frontend consults
     *      alongside this preview.
     * @param offerId  The offer to preview accepting.
     * @param acceptor The prospective acceptor (the funds-mover).
     * @return preview  See {OfferAcceptFacet.AcceptPreview}.
     */
    function previewAccept(uint256 offerId, address acceptor)
        external
        view
        returns (OfferAcceptFacet.AcceptPreview memory preview)
    {
        // #1835 (Codex #1891 F15 → F18) — the protocol-wide pause, ahead of
        // the offer lookup itself. `whenNotPaused` on both accept entry points
        // runs before ANY of the function body, offer validation included, so a
        // stale or malformed cached id previewed while paused must answer
        // `ProtocolPaused` — not `InvalidOffer`, which is what this surface did
        // when the classifier sat merely at the top of the precondition chain.
        //
        // F15 moved this to the top of that chain and the comment claimed it
        // "outranks every classifier". It did not: the `InvalidOffer` revert
        // above the chain still won. Same lesson as F3-F11, one level further
        // out — a check placed at the top of a list is not at the top of the
        // FUNCTION.
        //
        // The trade-off is deliberate: returning here leaves the happy-path
        // projections zeroed for a paused preview, where the doc-block promises
        // them "for recoverable error cases". A pause is not recoverable by the
        // caller and no accept can be attempted while it holds, so there is no
        // quote to render — a surface on this code shows the paused state, not
        // numbers.
        if (LibPausable.paused()) {
            preview.errorCode = OfferAcceptFacet.AcceptError.ProtocolPaused;
            return preview;
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();

        // ─── Happy-path projections (populated unconditionally) ─────
        bool _isErc20 = offer.assetType == LibVaipakam.AssetType.ERC20;
        bool _isLender = offer.offerType == LibVaipakam.OfferType.Lender;

        // Role-aware mapping mirrors `LoanFacet._copyOfferToLoan` on the
        // non-match path. NFT rentals stay structurally single-value
        // (see the PR #187 Codex P1 comment at LoanFacet.sol L678-L691).
        preview.effectivePrincipal = _isErc20
            ? (_isLender ? offer.amountMax : offer.amount)
            : offer.amount;
        preview.interestRateBps = _isErc20
            ? (_isLender ? offer.interestRateBps : offer.interestRateBpsMax)
            : offer.interestRateBps;
        preview.collateralAmount = offer.collateralAmount;

        // #951 v2 (Codex #959 bind-to-live) — for a lender-sale vehicle the buyer
        // binds principal / collateral against the LIVE loan (not the immutable
        // offer snapshot), so the preview must project the live values too — else
        // it would quote a stale principal the accept then rejects at the bind.
        // Principal `==` live, collateral projected as the live floor the buyer
        // signs (`>=`-bound). Rate stays the seller's offer ask (bound to offer).
        uint256 _saleLoanId = s.saleOfferToLoanId[offerId];
        if (_saleLoanId != 0) {
            LibVaipakam.Loan storage _saleLoan = s.loans[_saleLoanId];
            preview.effectivePrincipal = _saleLoan.principal;
            preview.collateralAmount = _saleLoan.collateralAmount;
        }

        // Collateral residual refund — only fires for borrower offers
        // on the ERC-20 lending + ERC-20 collateral direct-accept path
        // (see `_refundBorrowerCollateralResidualIfNeeded` for the exact
        // gating, including the PR #187 Codex P2 NFT-lending carve-out
        // which prevents an unfunded refund from underflowing the
        // protocolTrackedVaultBalance counter). Projecting a residual
        // for any borrower offer with `collateralAmountMax > collateralAmount`
        // would drift from execution when the lending leg is NFT (the
        // create-time excess deposit never fired) or when the collateral
        // leg is non-ERC-20.
        if (
            !_isLender
                && _isErc20
                && offer.collateralAssetType == LibVaipakam.AssetType.ERC20
                && offer.collateralAmountMax > offer.collateralAmount
        ) {
            preview.collateralResidualRefund =
                offer.collateralAmountMax - offer.collateralAmount;
        }

        // LIF estimate. ERC-20 path only — NFT rental offers don't
        // charge LIF (the `tryApplyBorrowerLif` chain is guarded behind
        // `offer.assetType == ERC20` in `_acceptOffer`). Mirrors the FULL
        // precondition `tryApplyBorrowerLif` checks (consent + liquid +
        // canQuote + vault holds >= the full LIF-equivalent VPFI); see the
        // Codex round-1 P1 (#196) note in git history for the vault-balance gap.
        //
        // #951 (Codex #959 round-5) — a lender-sale-vehicle accept is a
        // secondary-market position transfer and `_acceptOffer` skips the LIF
        // entirely for it (the underlying loan already paid its LIF at
        // origination). Mirror that carve-out so the preview doesn't quote a
        // phantom fee; `lifEstimate` stays 0.
        if (_isErc20 && _saleLoanId == 0) {
            address _borrower = _isLender ? acceptor : offer.creator;
            // HoldOnly hybrid (#1352, §F3): quote exactly what `_acceptOffer`
            // will charge — the shared helper resolves the consent-gated
            // hold-tier discount (capped 50%, liquid-asset only) and applies it
            // to the lending-asset LIF. The retired peg-custody VPFI path is
            // gone. Resolve liquidity the same way accept does so the discount
            // gate matches.
            preview.lifEstimate = LibVPFIDiscount.holdOnlyBorrowerLif(
                _borrower,
                preview.effectivePrincipal,
                OracleFacet(address(this)).checkLiquidity(offer.lendingAsset) ==
                    LibVaipakam.LiquidityStatus.Liquid,
                // #1347 — the accept-time preview quotes the HoldOnly (non-Full)
                // LIF: `previewAccept` takes no Full opt-in, and the borrower's
                // `+10%` Full bump only materialises once the Full tariff is
                // confirmed at accept. The Full-aware quote is a separate view
                // (`FeeEntitlementFacet.quoteCStar` + the Stage-E preview wiring).
                /*fullMode=*/ false
            );
        }

        // ─── Precondition chain (first failure wins) ────────────────
        // Order mirrors `_acceptOffer`. First failing check sets `errorCode`;
        // subsequent checks are short-circuited via the sentinel return.

        // (The protocol-wide pause is classified at the very TOP of this
        // function, ahead of the offer lookup — see #1891 F15/F18 there. It is
        // not in this chain because `whenNotPaused` is a modifier and outranks
        // the whole body, offer validation included. The per-asset pause
        // (`AssetPaused`) IS in this chain, further down, because it is an
        // ordinary check inside `_acceptOffer`.)
        if (offer.accepted) {
            preview.errorCode = OfferAcceptFacet.AcceptError.OfferAlreadyAccepted;
            return preview;
        }
        // #951 v2 (Codex #959) — mirror `_acceptOffer`'s cancelled-offer guard.
        if (s.offerCancelled[offerId]) {
            preview.errorCode = OfferAcceptFacet.AcceptError.OfferIsCancelled;
            return preview;
        }
        // T-407-C (#566) — a partially-filled offer must advance via
        // `matchOffers`, not `acceptOffer`. Order matches `_acceptOffer`.
        if (offer.amountFilled > 0) {
            preview.errorCode = OfferAcceptFacet.AcceptError.OfferPartiallyFilled;
            return preview;
        }
        // #195 — GTT lazy-expiry, before sanctions / pause / KYC.
        if (LibVaipakam.isOfferExpired(offer)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.OfferExpired;
            return preview;
        }
        // #1503 PR-A (Codex #1505 r2 + r3 ordering) — mirror `_acceptOffer`'s
        // live-maturity gate for a sale vehicle at ITS position: immediately
        // after the expiry gate, BEFORE sanctions / pause / consent / KYC.
        // First-failure parity is the point of this chain — a legacy GTC
        // vehicle past maturity that also trips a later check must preview
        // the classifier the transaction will actually revert with.
        // `Active` persists through the grace window, and a pre-upgrade GTC
        // vehicle (`expiresAt == 0`) never trips the expiry gate above.
        if (_saleLoanId != 0) {
            LibVaipakam.Loan storage _saleLoanM = s.loans[_saleLoanId];
            // The position must still EXIST before anything is measured about
            // it (Codex #1635 r10). This classifier used to sit far below the
            // solvency block, so a listing whose loan was HF-liquidated before
            // its stale listing was torn down previewed as "below its solvency
            // floor" — a health shortfall reported for a position that no
            // longer exists. Hoisted to match `_acceptOffer`, which now rejects
            // a non-Active linked loan before it measures anything, so
            // first-failure parity between the two surfaces still holds.
            if (_saleLoanM.status != LibVaipakam.LoanStatus.Active) {
                preview.errorCode = OfferAcceptFacet.AcceptError.SaleLoanNotActive;
                return preview;
            }
            if (
                block.timestamp >=
                uint256(_saleLoanM.startTime) +
                    uint256(_saleLoanM.durationDays) * 1 days
            ) {
                preview.errorCode =
                    OfferAcceptFacet.AcceptError.SaleLoanPastMaturity;
                return preview;
            }
            // #1503 PR-E (design item 11) — mirror the accept-time solvency
            // admission floor. Classified rather than reverted so the buyer
            // sees "this position is below its sale floor" on the card.
            // The classifier's code is preserved, not collapsed. Code 1 is
            // genuinely "health factor below its floor"; 2-5 are weaker
            // inherited terms or a live LTV over the admission cap, and
            // reporting those as a health-factor failure would tell the buyer
            // something false about their position (Codex #1635 r4). The
            // `SALE_ADMISSION_UNAVAILABLE` sentinel — the classifier could not
            // be consulted, so nothing was measured — lands on the same neutral
            // blocked result for exactly that reason (Codex #1635 r5).
            (uint8 _saleCode, , ) = LibSaleSolvency.saleSolvency(_saleLoanId);
            if (_saleCode == 1) {
                preview.errorCode = OfferAcceptFacet
                    .AcceptError
                    .SalePositionBelowSolvencyFloor;
                return preview;
            }
            if (_saleCode != 0) {
                preview.errorCode = OfferAcceptFacet
                    .AcceptError
                    .SaleAdmissionBlocked;
                return preview;
            }
            // #1835 (Codex #1891 F1) — the accept refuses a vehicle whose
            // behavioural terms disagree with the live loan. Classified here so
            // the card can disable "Accept" instead of letting the buyer
            // discover it by burning gas.
            //
        }
        if (LibVaipakam.isSanctionedAddress(acceptor)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.SanctionedAcceptor;
            return preview;
        }
        if (LibVaipakam.isSanctionedAddress(offer.creator)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.SanctionedCreator;
            return preview;
        }
        // Per-asset pause check — read storage directly so we don't
        // re-enter the reverting helper (`LibFacet.requireAssetNotPaused`).
        if (
            s.assetPaused[offer.lendingAsset]
                || s.assetPaused[offer.collateralAsset]
        ) {
            preview.errorCode = OfferAcceptFacet.AcceptError.AssetPaused;
            return preview;
        }
        // Country-pair check — only fires when countries differ AND the
        // pair is not allowed. On retail (`canTradeBetween` pure-true),
        // this branch is unreachable; left in for the industrial fork.
        {
            string memory _creatorCountry = ProfileFacet(address(this))
                .getUserCountry(offer.creator);
            string memory _acceptorCountry = ProfileFacet(address(this))
                .getUserCountry(acceptor);
            if (
                keccak256(abi.encodePacked(_creatorCountry))
                    != keccak256(abi.encodePacked(_acceptorCountry))
                    && !LibVaipakam.canTradeBetween(
                        _creatorCountry,
                        _acceptorCountry
                    )
            ) {
                preview.errorCode =
                    OfferAcceptFacet.AcceptError.CountriesNotCompatible;
                return preview;
            }
        }
        // Defensive creator-consent check — mirrors `_acceptOffer`.
        if (!offer.creatorRiskAndTermsConsent) {
            preview.errorCode =
                OfferAcceptFacet.AcceptError.RiskAndTermsConsentRequired;
            return preview;
        }
        // KYC threshold — both sides must clear the tier gate at the projected
        // transaction value. Reads the numeraire via the PUBLIC cross-facet view
        // (the private impl stays on OfferAcceptFacet next to `_acceptOffer`).
        {
            uint256 _valueNumeraire = OfferAcceptFacet(address(this))
                .calculateTransactionValueNumeraire(
                    offerId,
                    preview.effectivePrincipal
                );
            if (
                !ProfileFacet(address(this)).meetsKYCRequirement(
                    offer.creator,
                    _valueNumeraire
                )
                    || !ProfileFacet(address(this)).meetsKYCRequirement(
                        acceptor,
                        _valueNumeraire
                    )
            ) {
                preview.errorCode = OfferAcceptFacet.AcceptError.KYCRequired;
                return preview;
            }
        }

        // #951 v2 (Codex #959 bind-to-live) — sale-vehicle structural blockers,
        // mirroring `LoanFacet.initiateLoan`'s sale-vehicle reverts so the UI can
        // disable "Accept" without a revert. Placed last: `initiateLoan` runs
        // after the accept-time checks above. The linked loan must still be Active
        // (else the position doesn't exist), and the buyer must not be the loan's
        // CURRENT borrower (resolved live via `ownerOf`, not the stale stored
        // `borrower` — Codex #959 round-8 P1).
        // #1835 (Codex #1891 F1/F10/F11) — the accept refuses a vehicle whose
        // four behavioural terms disagree with the live loan. Classified so the
        // card can disable "Accept" rather than letting the buyer discover it
        // by burning gas.
        //
        // ORDERED LAST AMONG THE REFUSALS NOTHING CAN CURE, mirroring
        // `_acceptOffer`. Every classifier above — expiry, the sale branch's
        // status / maturity / solvency, sanctions, asset-pause, country,
        // risk-consent, KYC — is both more structural AND actionable, where
        // this one is not: it tells the seller to relist, and
        // `_boundListingExpiry`, `createLoanSaleOffer` and `OfferCreateFacet`
        // each REFUSE that relist in the states they describe, so the advice
        // could not be taken.
        //
        // It sits ABOVE `SaleSelfBuy` deliberately, and that is not an
        // exception to the rule but the rule applied honestly (Codex #1891
        // F14). Self-buy is the one case where relisting IS an available
        // remedy: the seller can relist and the new listing is correct — it
        // simply still cannot be bought by THIS buyer, who is the linked loan's
        // own borrower. So the two are not the same question, and staleness
        // legitimately outranks it.
        //
        // That ordering is also what keeps first-failure parity with the
        // accept, where the borrower-vs-buyer check lives downstream in
        // `LoanFacet.initiateLoan` — after the stale comparison. The
        // alternative, hoisting an `ownerOf` read into `_acceptOffer` to put
        // self-buy first, would add an external call to a frame already at the
        // viaIR stack budget to reorder two refusals whose priority is
        // genuinely arguable.
        //
        // State the rule rather than the position: this arrived as SIX review
        // findings (#1891 F3/F4/F5/F10/F11/F14), each moving the check behind
        // the one gate that finding named while the next stayed ahead of it. A
        // new classifier belongs ABOVE this one unless, like self-buy, relisting
        // genuinely remains available.
        if (_saleLoanId != 0) {
            LibVaipakam.Offer storage _vehicle = s.offers[offerId];
            LibVaipakam.Loan storage _staleChk = s.loans[_saleLoanId];
            if (
                _vehicle.allowsPartialRepay != _staleChk.allowsPartialRepay ||
                _vehicle.allowsPrepayListing != _staleChk.allowsPrepayListing ||
                _vehicle.useFullTermInterest != _staleChk.useFullTermInterest ||
                _vehicle.periodicInterestCadence != _staleChk.periodicInterestCadence
            ) {
                preview.errorCode = OfferAcceptFacet
                    .AcceptError
                    .SaleListingTermsStale;
                return preview;
            }
        }

        if (_saleLoanId != 0) {
            LibVaipakam.Loan storage _saleLoan = s.loans[_saleLoanId];
            // (Both the `Active` and the live-maturity classifiers sit EARLIER
            // in this chain — right after the expiry gate, mirroring
            // `_acceptOffer`'s ordering; Codex #1505 r3, #1635 r10. The
            // `Active` check moved up there because the solvency block must not
            // measure a position that no longer exists, which left the copy
            // that used to be here unreachable.)
            if (acceptor == LibERC721.ownerOf(_saleLoan.borrowerTokenId)) {
                preview.errorCode = OfferAcceptFacet.AcceptError.SaleSelfBuy;
                return preview;
            }
        }

        // The risk-access gate is surfaced separately via
        // `RiskPreviewFacet.previewOfferAcceptBlock(offerId, acceptor)` (0 = OK,
        // 1 = tier too low, 2 = illiquid pair needs standing consent), which the
        // frontend consults alongside this preview. (#671 phase 2 / Codex #729
        // r3 finding C — kept out-of-facet; now that #980 split the preview out,
        // folding it in is a possible follow-up.)

        // Happy path: errorCode stays `None`.
    }
}
