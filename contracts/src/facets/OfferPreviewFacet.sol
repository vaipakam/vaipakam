// src/facets/OfferPreviewFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibSaleSolvency} from "../libraries/LibSaleSolvency.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibCadenceAdmission} from "../libraries/LibCadenceAdmission.sol";
import {LibNumeraireValueRead} from "../libraries/LibNumeraireValueRead.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibOfferAdmission} from "../libraries/LibOfferAdmission.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OfferPriceGuardFacet} from "./OfferPriceGuardFacet.sol";
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

    /// @notice #3358 — the first check loan creation runs after the accept or
    ///         match core that would refuse the loan, if any: the offer's
    ///         cadence (#3025), then the makers' price-move guards (#3358).
    enum OriginationRefusal {
        None,
        CadenceNotAdmitted,
        PriceGuardRefused
    }

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
        // F18's first fix returned IMMEDIATELY here, which zeroed the
        // happy-path projections for a paused preview. That was a real defect,
        // not the harmless trade-off the comment claimed (Codex #1891 F21):
        // a consumer reading `lifEstimate` alone sees 0 and renders it as a
        // fee WAIVER, and that false quote can outlive the pause and precede an
        // acceptance that charges the normal fee. "No accept is possible while
        // paused" does not mean the quote goes unread.
        //
        // So the pause is split in two, which is what satisfies both findings
        // at once:
        //   - here, only for an offer that does not exist — nothing to quote,
        //     and the accept would answer `EnforcedPause` rather than
        //     `InvalidOffer` (F18);
        //   - below, after the projections are populated (F21).
        bool _paused = LibPausable.paused();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) {
            if (_paused) {
                preview.errorCode = OfferAcceptFacet.AcceptError.ProtocolPaused;
                return preview;
            }
            revert InvalidOffer();
        }
        return _previewAcceptCore(offer, offerId, acceptor, _paused, OfferAcceptFacet.AcceptError.None);
    }

    /**
     * @notice The accept preview over an offer's VALUES: the projections and
     *         the precondition chain {previewAccept} reports, shared with
     *         {previewSignedOfferAccept} so the two cannot drift (#3552).
     * @dev `offer` is a stored offer copied to memory, or the offer a
     *      signed-offer fill would create. `offerId` is 0 for the latter: no
     *      id exists until the fill, and every id-keyed record (a sale link, a
     *      cancellation, a price guard) is empty at id 0, which is true of an
     *      offer that does not exist yet. `preBlock`, when not `None`, is the
     *      route's own first refusal; it is reported after the protocol pause
     *      and before every shared check, which is where the signed fill runs
     *      its own checks. An `Offer memory` argument is one pointer, not a
     *      spill of its fields, so this adds no stack depth.
     */
    function _previewAcceptCore(
        LibVaipakam.Offer memory offer,
        uint256 offerId,
        address acceptor,
        bool _paused,
        OfferAcceptFacet.AcceptError preBlock
    ) private view returns (OfferAcceptFacet.AcceptPreview memory preview) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

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
        // charge LIF (the charge is guarded behind `offer.assetType ==
        // ERC20` in `_acceptOffer`).
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

        // The protocol-wide pause, ahead of every classifier below, because
        // `whenNotPaused` is a MODIFIER on both accept entry points — while it
        // holds the function body never runs, so nothing below can be the
        // transaction's real first failure (#1891 F15/F18). It sits here rather
        // than before the projections so a paused preview still carries a
        // truthful quote instead of a zeroed one a consumer would read as a fee
        // waiver (F21).
        //
        // Not to be confused with the per-asset pause (`AssetPaused`), further
        // down and genuinely part of this chain — that one is an ordinary check
        // inside `_acceptOffer`.
        if (_paused) {
            preview.errorCode = OfferAcceptFacet.AcceptError.ProtocolPaused;
            return preview;
        }
        if (preBlock != OfferAcceptFacet.AcceptError.None) {
            preview.errorCode = preBlock;
            return preview;
        }
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
        if (LibVaipakam.offerExpiryPassed(offer.expiresAt)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.OfferExpired;
            return preview;
        }
        // #3443 — mirrors `_acceptOffer`'s terms-age gate, right after expiry.
        if (!LibTiming.termsAged(offer.termsSetAt)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.TermsTooFresh;
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
                block.timestamp >= LibLoanClock.maturity(_saleLoanM)
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
            uint256 _valueNumeraire = offerId != 0
                ? OfferAcceptFacet(address(this)).calculateTransactionValueNumeraire(
                    offerId,
                    preview.effectivePrincipal
                )
                : _unstoredTransactionValue(offer, preview.effectivePrincipal);
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

        // #1835 (Codex #1891 F25) — the GENERIC self-trade refusal, which this
        // surface was missing entirely. `_acceptOffer` resolves roles and
        // reverts `SelfTradeForbidden` when `lender == borrower` (`:1111`);
        // since one side is always the creator and the other the acceptor, that
        // collapses to `acceptor == offer.creator`.
        //
        // Distinct from `SaleSelfBuy` below, and the distinction is the whole
        // finding: that one is the linked LOAN's current borrower buying the
        // vehicle, this one is the EXITING SELLER accepting their own offer. On
        // a stale listing the seller previewed `SaleListingTermsStale` and was
        // told to relist — but a relisted offer still cannot be self-filled, so
        // the advice was unactionable in the same way every other misordering on
        // this PR was.
        //
        // Positioned exactly where the accept raises it: after KYC, before the
        // vault floor and the stale comparison.
        if (acceptor == offer.creator) {
            preview.errorCode = OfferAcceptFacet.AcceptError.SelfTrade;
            return preview;
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
            if (acceptor == LibPositionNFT.ownerOf(_saleLoan.borrowerTokenId)) {
                preview.errorCode = OfferAcceptFacet.AcceptError.SaleSelfBuy;
                return preview;
            }
        }

        // #3025 — loan creation re-admits the offer's cadence on the loan it
        // opens (inside `initiateLoan`, after every check above and before the
        // refinance hook below), so a cadence the rule no longer admits is
        // reported here rather than discovered at signing. The lender-sale
        // vehicle is exempt there, so it is here.
        if (_saleLoanId == 0) {
            try OfferPreviewFacet(address(this)).requireCadenceAdmitted(
                LibCadenceAdmission.originationTermsFromMemory(offer, preview.effectivePrincipal)
            ) {} catch {
                preview.errorCode = OfferAcceptFacet.AcceptError.CadenceNotAdmitted;
                return preview;
            }
        }

        // #3358 — loan creation then asks the offer's price-move guard, the
        // same entry, so a fill the guard would refuse is reported here.
        if (!_priceGuardsClear(s, offerId, 0)) {
            preview.errorCode = OfferAcceptFacet.AcceptError.PriceGuardRefused;
            return preview;
        }

        // #2407 — a refinance-tagged offer completes only if it is its target
        // loan's recorded request and no offset is open on that loan;
        // otherwise the refinance hook, which runs after every check above,
        // reverts (`RefinanceRequestNotRecorded` / `RefinanceBlockedByOffset`).
        // Last in the chain because it is last in execution.
        if (
            offer.refinanceTargetLoanId != 0 &&
            !LibRefinanceRequest.isTakeable(s, offer.refinanceTargetLoanId, offerId)
        ) {
            preview.errorCode = OfferAcceptFacet.AcceptError.RefinanceRequestUntakeable;
            return preview;
        }

        // The risk-access gate is surfaced separately via
        // `RiskPreviewFacet.previewOfferAcceptBlock(offerId, acceptor)` (0 = OK,
        // 1 = tier too low, 2 = illiquid pair needs standing consent), which the
        // frontend consults alongside this preview. (#671 phase 2 / Codex #729
        // r3 finding C — kept out-of-facet; now that #980 split the preview out,
        // folding it in is a possible follow-up.)

        // Happy path: errorCode stays `None`.
    }

    // ─── #3552 — signed-order accept preview ─────────────────────────────

    /// @notice What {previewSignedOfferAccept} reports.
    /// @param accept           The shared accept preview: the projections and
    ///                         the first blocker, signed-order blockers
    ///                         included (see `OfferAcceptFacet.AcceptError`).
    /// @param orderHash        The order's hash, the key its fill and
    ///                         cancellation records use.
    /// @param stakeAsset       The asset the fill draws from the signer's
    ///                         vault: the principal for a lender order, the
    ///                         collateral for a borrower order.
    /// @param stakeRequired    How much of it the fill draws (the order's
    ///                         upper bound).
    /// @param makerFreeHolding The signer's free vault balance of it now, the
    ///                         figure the fill compares with `stakeRequired`.
    struct SignedAcceptPreview {
        OfferAcceptFacet.AcceptPreview accept;
        bytes32 orderHash;
        address stakeAsset;
        uint256 stakeRequired;
        uint256 makerFreeHolding;
    }

    /**
     * @notice Read-only projection and first-failing blocker for filling the
     *         vault-backed signed order `o` (signature `sig`) through
     *         `SignedOfferFacet.acceptSignedOffer` by `acceptor`, the signed
     *         counterpart of {previewAccept}. A signed order has no offer id
     *         until its fill creates one, so {previewAccept} cannot be asked.
     * @dev One rule, one place: the projections and every accept check come
     *      from the same core {previewAccept} runs, over the offer the fill
     *      would create; the order's own checks (Full ceiling, deadline,
     *      expiry, nonce, consumed hash) come from
     *      {LibSignedOffer.vetFailure}, the rule the fill enforces. They are
     *      reported in the fill's order: the protocol pause, the order's own
     *      checks, its signature, its shape, the signer's free vault balance
     *      of the stake, the offer-book value floor, then the accept checks.
     *
     *      What this does NOT check, stated so a clear answer is not read as
     *      more than it is: the creation checks the fill runs on the maker's
     *      terms besides the shape and the value floor (duration and amount
     *      bounds, the collateral floor, self-collateral, the maker's
     *      risk-access standing and protected-account mode), which an order
     *      signed through the app already meets; the acceptor's risk-access
     *      gate, read separately as for any offer
     *      (`RiskPreviewFacet.previewOfferAcceptBlock` is keyed on a stored
     *      offer, so a signed order has no such answer yet); and the
     *      wallet-backed fill (`acceptSignedOfferWithPermit`), whose stake is
     *      a Permit2 pull from the signer's wallet that this view does not
     *      read. The fill's own simulation remains the final word.
     * @param o        The signed order, as the book lists it.
     * @param sig      The signer's signature over it (EOA or ERC-1271).
     * @param acceptor The prospective taker.
     */
    function previewSignedOfferAccept(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        address acceptor
    ) external view returns (SignedAcceptPreview memory p) {
        p.orderHash = LibSignedOffer.hashStruct(o);
        LibVaipakam.CreateOfferParams memory params = LibSignedOffer.toCreateOfferParams(o);
        bool lender = params.offerType == LibVaipakam.OfferType.Lender;
        // The stake `OfferCreateFacet._creatorPullAmount` draws for the two
        // ERC-20 shapes a signed order may take (the params already carry the
        // `amountMax == 0` collapse).
        p.stakeAsset = lender ? params.lendingAsset : params.collateralAsset;
        p.stakeRequired = lender
            ? params.amountMax
            : (params.collateralAmountMax == 0 ? params.collateralAmount : params.collateralAmountMax);
        p.makerFreeHolding = LibEncumbrance.freeBalance(
            o.signer, p.stakeAsset, 0, LibVaipakam.trackedHolding(o.signer, p.stakeAsset, 0)
        );
        p.accept = _previewAcceptCore(
            _asMaterialized(params, o.signer), 0, acceptor, LibPausable.paused(), _signedBlock(o, sig, p, params)
        );
    }

    /// @dev The signed fill's own first refusal, in its order, or `None`.
    function _signedBlock(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        SignedAcceptPreview memory p,
        LibVaipakam.CreateOfferParams memory params
    ) private view returns (OfferAcceptFacet.AcceptError) {
        LibSignedOffer.VetFailure f = LibSignedOffer.vetFailure(o, p.orderHash);
        if (f == LibSignedOffer.VetFailure.FullNeedsMaxCStar) return OfferAcceptFacet.AcceptError.SignedOfferMalformed;
        if (f == LibSignedOffer.VetFailure.DeadlinePassed) return OfferAcceptFacet.AcceptError.SignedOfferDeadlinePassed;
        if (f == LibSignedOffer.VetFailure.Expired) return OfferAcceptFacet.AcceptError.OfferExpired;
        if (f == LibSignedOffer.VetFailure.NonceInvalidated) return OfferAcceptFacet.AcceptError.SignedOfferNonceUsed;
        if (f == LibSignedOffer.VetFailure.Consumed) return OfferAcceptFacet.AcceptError.SignedOfferConsumed;
        (bool ok, ) = LibSignedOffer.verify(o, sig);
        if (!ok) return OfferAcceptFacet.AcceptError.SignedOfferBadSignature;
        // `OfferCreateFacet._materializeSignedOffer`'s shape: both legs
        // ERC-20, no refinance target.
        if (
            params.assetType != LibVaipakam.AssetType.ERC20
                || params.collateralAssetType != LibVaipakam.AssetType.ERC20
                || params.refinanceTargetLoanId != 0
        ) return OfferAcceptFacet.AcceptError.SignedOfferUnsupportedShape;
        if (p.makerFreeHolding < p.stakeRequired) return OfferAcceptFacet.AcceptError.SignedOfferMakerShort;
        (bool below, , ) = LibOfferAdmission.valueBelowFloor(params.lendingAsset, params.assetType, params.amount);
        if (below) return OfferAcceptFacet.AcceptError.SignedOfferBelowMinimumValue;
        return OfferAcceptFacet.AcceptError.None;
    }

    /// @dev The term fields the fill would write on the offer it creates for
    ///      `params` (`OfferCreateFacet._writeOfferFields` copies each one
    ///      verbatim), with what a fresh signed materialization carries: not
    ///      accepted, nothing filled, no terms age (#3443) and the signer's
    ///      consent, which the signature is. Derived and bookkeeping fields the
    ///      accept checks do not read stay zero.
    function _asMaterialized(LibVaipakam.CreateOfferParams memory params, address signer)
        private
        pure
        returns (LibVaipakam.Offer memory offer)
    {
        offer.creator = signer;
        offer.offerType = params.offerType;
        offer.lendingAsset = params.lendingAsset;
        offer.amount = params.amount;
        offer.amountMax = params.amountMax;
        offer.interestRateBps = params.interestRateBps;
        offer.interestRateBpsMax = params.interestRateBpsMax;
        offer.collateralAsset = params.collateralAsset;
        offer.collateralAmount = params.collateralAmount;
        offer.collateralAmountMax = params.collateralAmountMax;
        offer.durationDays = params.durationDays;
        offer.assetType = params.assetType;
        offer.collateralAssetType = params.collateralAssetType;
        offer.expiresAt = params.expiresAt;
        offer.periodicInterestCadence = params.periodicInterestCadence;
        offer.refinanceTargetLoanId = params.refinanceTargetLoanId;
        offer.creatorRiskAndTermsConsent = true;
    }

    /// @dev The KYC transaction value of an offer that is not stored yet:
    ///      the liquid value of the principal plus the liquid value of the
    ///      collateral, the rule `OfferAcceptFacet._calculateTransactionValueNumeraire`
    ///      applies, read through the same `NumeraireValueFacet` view. A
    ///      signed order is never a lender-sale vehicle, so the collateral is
    ///      the offer's own and the vehicle substitution there does not arise.
    function _unstoredTransactionValue(LibVaipakam.Offer memory offer, uint256 principal)
        private
        view
        returns (uint256)
    {
        return NumeraireValueFacet(address(this)).getLiquidNumeraireValue(offer.lendingAsset, principal)
            + NumeraireValueFacet(address(this)).getLiquidNumeraireValue(offer.collateralAsset, offer.collateralAmount);
    }

    // ─── #3009 — periodic-interest cadence admission ─────────────────────

    /// @notice One cadence's admission verdict.
    /// @param cadence  The cadence.
    /// @param admitted Offer creation admits the cadence on these terms.
    /// @param refusal  When not admitted, the exact revert data creation
    ///                 raises (`PeriodicInterestDisabled`,
    ///                 `CadenceNotAllowedForIlliquid` or `CadenceNotAllowed`),
    ///                 decodable with the Diamond ABI. Empty with `admitted`
    ///                 false means the rule could not be evaluated (the check
    ///                 reverted without data), which is not an admission.
    struct CadenceAdmission {
        LibVaipakam.PeriodicInterestCadence cadence;
        bool admitted;
        bytes refusal;
    }

    /// @notice What the cadence rule reads for a set of offer terms, and its
    ///         verdict for every cadence.
    /// @param periodicInterestEnabled The protocol switch. While off only
    ///                                `None` is admitted.
    /// @param principalLiquidity      The lending asset's class, as creation
    ///                                records it.
    /// @param collateralLiquidity     The collateral's class, as creation
    ///                                records it (Illiquid for a rental, which
    ///                                carries no collateral leg).
    /// @param bothLegsQualify         Both legs liquid AND ERC-20, which
    ///                                periodic interest needs.
    /// @param annualFloorApplies      The loan is longer than 365 days, the
    ///                                switch is on and both legs qualify, so
    ///                                `None` is refused and at least `Annual`
    ///                                is required.
    /// @param principalNumeraire      The principal's value the threshold is
    ///                                compared with (1e18 numeraire units,
    ///                                rounded down; 0 when it cannot be
    ///                                valued, which reads as below the
    ///                                threshold).
    /// @param threshold               The finer-cadence threshold in effect.
    /// @param cadences                One verdict per cadence, `None` first.
    struct CadenceAdmissionPreview {
        bool periodicInterestEnabled;
        LibVaipakam.LiquidityStatus principalLiquidity;
        LibVaipakam.LiquidityStatus collateralLiquidity;
        bool bothLegsQualify;
        bool annualFloorApplies;
        uint256 principalNumeraire;
        uint256 threshold;
        CadenceAdmission[] cadences;
    }

    /**
     * @notice Reverts with the refusal offer creation raises for a cadence on
     *         these terms, or returns when it is admitted. The rule is
     *         {LibCadenceAdmission}'s, the one creation and offer mutation
     *         enforce; this entry exists so {previewCadenceAdmission} can
     *         collect each refusal's exact revert data.
     */
    function requireCadenceAdmitted(LibCadenceAdmission.Terms calldata terms) external view {
        LibCadenceAdmission.enforce(terms);
    }

    /**
     * @notice #3025 — reverts with the rule's refusal when a loan opened now
     *         from `offerId` with `principal` funded may not carry the offer's
     *         cadence; returns when it may. Loan creation calls it for every
     *         origination from an offer, and the accept and match previews
     *         call it to report the same refusal before anyone signs.
     * @dev The terms are {LibCadenceAdmission.originationTerms}: the offer's
     *      own terms, the funded principal and both legs' liquidity read now,
     *      against the live switch and threshold. A lender-sale vehicle is
     *      exempt from the rule; its callers do not ask.
     * @param offerId   The offer the loan opens from (the borrower offer on a
     *                  match).
     * @param principal The principal the loan funds.
     */
    function requireOriginationCadenceAdmitted(uint256 offerId, uint256 principal) external view {
        LibCadenceAdmission.enforce(
            LibCadenceAdmission.originationTerms(LibVaipakam.storageSlot().offers[offerId], principal)
        );
    }

    /**
     * @notice #3358 — the first origination check loan creation would refuse
     *         a loan opened now from `offerId` with `principal` funded, where
     *         `otherOfferId` (0 = none) is the other maker's offer in a match:
     *         the cadence rule first, then the price-move guards, in loan
     *         creation's order.
     * @dev The match preview asks it (one call for both checks); the accept
     *      preview runs the same two checks inline. Each asks the entry loan
     *      creation itself calls, so the refusal is the one it would raise.
     *      Not for a lender-sale vehicle, which the cadence rule exempts.
     */
    function previewOriginationRefusal(uint256 offerId, uint256 principal, uint256 otherOfferId)
        external
        view
        returns (OriginationRefusal)
    {
        try OfferPreviewFacet(address(this)).requireOriginationCadenceAdmitted(offerId, principal) {} catch {
            return OriginationRefusal.CadenceNotAdmitted;
        }
        if (!_priceGuardsClear(LibVaipakam.storageSlot(), offerId, otherOfferId)) {
            return OriginationRefusal.PriceGuardRefused;
        }
        return OriginationRefusal.None;
    }

    /// @dev Whether the price-move guards on `offerId` and `otherOfferId`
    ///      (0 = none) would let a fill through now. Loan creation asks
    ///      `requireOfferPriceGuardsClear` only when one of them carries a
    ///      guard, so this asks only then too.
    function _priceGuardsClear(LibVaipakam.Storage storage s, uint256 offerId, uint256 otherOfferId)
        private
        view
        returns (bool)
    {
        if (s.offerPriceGuard[offerId].maxMoveBps == 0 && s.offerPriceGuard[otherOfferId].maxMoveBps == 0) {
            return true;
        }
        try OfferPriceGuardFacet(address(this)).requireOfferPriceGuardsClear(offerId, otherOfferId) {
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @notice The periodic-interest cadences an offer on these terms may
     *         carry, with the reason for each one it may not, so a create form
     *         offers only what creation will accept and says why the rest are
     *         closed.
     * @dev Liquidity is classified live, exactly as creation classifies it,
     *      so the answer can change with the oracle, the switch or the
     *      threshold before the offer is sent. It covers the cadence rule
     *      only: an offer refused for another reason (its duration, its
     *      amounts) is refused by creation whatever this says. A lender-sale
     *      vehicle is created by the protocol and is exempt from the rule, so
     *      this does not describe one.
     * @param lendingAsset        The principal asset.
     * @param amount              The offer's `amount` (the lower bound under a
     *                            range), which the threshold rows value.
     * @param assetType           The lending asset's type.
     * @param collateralAsset     The collateral asset.
     * @param collateralAssetType The collateral asset's type.
     * @param durationDays        The loan duration in days.
     */
    function previewCadenceAdmission(
        address lendingAsset,
        uint256 amount,
        LibVaipakam.AssetType assetType,
        address collateralAsset,
        LibVaipakam.AssetType collateralAssetType,
        uint256 durationDays
    ) external view returns (CadenceAdmissionPreview memory preview) {
        LibCadenceAdmission.Terms memory terms;
        terms.lendingAsset = lendingAsset;
        terms.amount = amount;
        terms.durationDays = durationDays;
        terms.assetType = assetType;
        terms.collateralAssetType = collateralAssetType;
        (terms.principalLiquidity, terms.collateralLiquidity) =
            LibCadenceAdmission.legLiquidity(lendingAsset, assetType, collateralAsset);

        preview.periodicInterestEnabled = LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled;
        preview.principalLiquidity = terms.principalLiquidity;
        preview.collateralLiquidity = terms.collateralLiquidity;
        preview.bothLegsQualify = LibCadenceAdmission.bothLiquid(terms);
        preview.annualFloorApplies = LibCadenceAdmission.annualFloorApplies(terms);
        preview.principalNumeraire = LibNumeraireValueRead.valueOrZero(lendingAsset, amount);
        preview.threshold = LibCadenceAdmission.threshold();

        uint256 count = uint256(type(LibVaipakam.PeriodicInterestCadence).max) + 1;
        preview.cadences = new CadenceAdmission[](count);
        for (uint256 i; i < count; ++i) {
            terms.cadence = LibVaipakam.PeriodicInterestCadence(i);
            preview.cadences[i].cadence = terms.cadence;
            try OfferPreviewFacet(address(this)).requireCadenceAdmitted(terms) {
                preview.cadences[i].admitted = true;
            } catch (bytes memory reason) {
                preview.cadences[i].refusal = reason;
            }
        }
    }
}
