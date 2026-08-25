// src/facets/EarlyWithdrawalDirectFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibSaleSolvency} from "../libraries/LibSaleSolvency.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LenderIntentFacet} from "./LenderIntentFacet.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";

/**
 * @title EarlyWithdrawalDirectFacet
 * @author Vaipakam Developer Team
 * @notice Lender early-withdrawal by the DIRECT route — selling an active loan
 *         position straight into a standing Lender Offer, in one transaction
 *         (Option 1 per README §9).
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental lender-sale requires NFT custody
 *      transfer — not supported in Phase 1).
 *
 *      SPLIT FROM {EarlyWithdrawalFacet} (#1780) for EIP-170 headroom, along
 *      the seam the two routes already had. Both routes move the SAME lender
 *      position and share none of their internals: the direct route's helpers
 *      are private to it, and the listed route's sale-vehicle helpers
 *      (`_submitSaleOffer`, `_buildSaleParams`, `_boundListingExpiry`,
 *      `_completeLoanSaleImpl`) are private to that. The combined facet had
 *      30 bytes of runtime headroom left, which is below the cost of a single
 *      cross-facet call, so the next behavioural fix to either route could not
 *      be deployed at all.
 *
 *      The seam is the one the canonical spec already sanctions for
 *      `OfferMatchFacet` — splitting a facet along a documented functional
 *      boundary "where necessary for deployability", rather than inventing a
 *      new decomposition. It is also the seam the two routes are DOCUMENTED
 *      along: the spec's keeper taxonomy lists `createLoanSaleOffer` as
 *      keeper-initiation and `completeLoanSale` as keeper-optional, which
 *      keeps the listed route's two halves together, while the direct route
 *      carries no keeper affordance at all.
 *
 *      Splitting the OTHER way — by authorisation model, so that listing and
 *      completion lived apart — was rejected: those two halves share the
 *      sale-vehicle invariants (the `loanToSaleOfferId` / `saleOfferToLoanId`
 *      link, the relist cooldown, the one-listing-per-loan rule) and are only
 *      correct when read together.
 *
 *      Storage is unchanged: both facets read the same {LibVaipakam} slot, so
 *      this is a pure relocation of routed selectors, not a migration.
 *
 *      Sanctions/KYC enforced via {LibCompliance}. The borrower and loan terms
 *      are unchanged — only the lender relationship transfers.
 */
contract EarlyWithdrawalDirectFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @param loanId The ID of the sold loan.
    /// @param originalLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param shortfallPaid Any shortfall amount paid by original lender.
    /// @param newLenderTokenId Position-NFT id minted for the new lender.
    /// @param newInterestRateBps Loan's interest rate AFTER the sale.
    ///        Unchanged in the lender-side sale path (borrower-favourability
    ///        rule per README §9 keeps the rate fixed); included for
    ///        cache-row freshness so consumers can self-update without a
    ///        follow-up read.
    /// @param newDurationDays Loan's duration AFTER the sale (unchanged
    ///        for the same reason).
    /// @param newDueTimestamp Computed maturity timestamp
    ///        (`startTime + durationDays * 1 days`) — also unchanged on
    ///        a sale, but explicit for consumer convenience.
    ///        EventSourcingAudit §3.15.
    /// @custom:event-category state-change/loan-mutation
    event LoanSold(
        uint256 indexed loanId,
        address indexed originalLender,
        address indexed newLender,
        uint256 shortfallPaid,
        uint256 newLenderTokenId,
        uint256 newInterestRateBps,
        uint256 newDurationDays,
        uint64 newDueTimestamp
    );

    /// @notice The buy offer being consumed as a sale vehicle is past its GTT
    ///         deadline. Mirrors `OfferAcceptFacet.OfferExpired` (same name +
    ///         same args ⇒ same EVM selector), so a caller decodes identical
    ///         revert data whichever path refused the fill.
    error OfferExpired(uint256 offerId, uint64 expiresAt);

    /// @notice The loan being sold has a live Preclose Option-3 offset offer on
    ///         it. Cancel the offset to reopen this route — completing it
    ///         settles the loan instead, leaving no position to sell. Mirrors
    ///         `EarlyWithdrawalFacet.OffsetActiveOnLoan` (same name, no args ⇒
    ///         same EVM selector), declared here rather than shared because the
    ///         #1780 split left the two sale hosts as separate contracts — the
    ///         same reason `OfferExpired` above is declared twice.
    error OffsetActiveOnLoan();

    /// @notice #1912 (#1503 items 7 + 8) — the standing buy offer's authored
    ///         terms disagree with the position it is being spent on, so
    ///         filling it would migrate the buyer into a loan they did not
    ///         author. Named per-field rather than folded into the generic
    ///         `InvalidSaleOffer` because a seller (or an interface quoting
    ///         for one) cannot act on "invalid": which term disagrees decides
    ///         whether they re-list, pick a different offer, or tell the buyer
    ///         to re-author theirs.
    ///
    ///         `which`: 0 useFullTermInterest · 1 allowsPartialRepay ·
    ///         2 allowsPrepayListing · 3 periodicInterestCadence ·
    ///         4 collateralTokenId · 5 collateralQuantity · 6 tokenId ·
    ///         7 quantity. Ordinals are append-only — a frontend maps them to
    ///         copy, so renumbering silently re-labels a live error.
    error SaleOfferTermsDisagree(uint8 which);

    /// @notice #1921 (#1503 item 5) — the standing buy offer's creator is the
    ///         CURRENT holder of the loan's borrower position, so filling it
    ///         would migrate the lender side onto the borrower and leave an
    ///         Active loan with `lender == borrower` — a party owing itself,
    ///         which breaks claim/repay accounting (`RepayFacet` then rejects
    ///         that wallet's ordinary repayment). The listed route already
    ///         refuses this exact case in `LoanFacet.initiateLoan` (resolved via
    ///         `ownerOf(borrowerTokenId)`), and `OfferAcceptFacet` surfaces it
    ///         as the `SaleSelfBuy` preview classifier; this is the same rule on
    ///         the direct route, which had neither the guard nor the live-holder
    ///         resolution. Named rather than folded into the generic
    ///         `InvalidSaleOffer` — the many shape checks above all raise that,
    ///         and self-dealing is a WHO-is-buying refusal, not a malformed
    ///         offer: the seller must pick a different buy offer, not re-list.
    error SaleBuyerIsBorrower(uint256 loanId, address borrower);

    /// @notice #1923 (#1503 item 9) — the position's LIVE remaining exposure
    ///         (to the fixed maturity) is longer than the duration the buy
    ///         offer's author consented to. A sale never moves the loan's
    ///         maturity (ProjectDetailsREADME: maturity is fixed at
    ///         origination), so the buyer inherits the remaining term as-is and
    ///         it must fit WITHIN their authored duration. One-directional, like
    ///         the inherited risk-terms and treasury-fee rules: a SHORTER
    ///         remaining term than authored stays sellable (capital returns
    ///         sooner — the better position), only over-exposure is refused.
    ///         Carries seconds, not days, because the check is measured off the
    ///         maturity timestamp rather than floored whole days.
    error SaleExposureExceedsAuthoredDuration(
        uint256 remainingSecs,
        uint256 authoredSecs
    );

    /// @notice #1923 (#1503 item 15) — the buy offer's amount is not EXACTLY the
    ///         loan's principal. The offer is single-valued (ranged/partial
    ///         rejected upstream) and is consumed whole — marked accepted, its
    ///         position NFT burned — so admitting an over-funded offer would
    ///         place the buyer in a SMALLER position than they authored while
    ///         burning the offer. The listed route builds its sale vehicle at
    ///         exactly `loan.principal`, so anything other than an exact match
    ///         is the door-dependent divergence §9 forbids. An amount BELOW the
    ///         principal cannot fund the sale; one ABOVE it is now refused
    ///         rather than silently refunded.
    error SaleAmountNotExactPrincipal(uint256 authored, uint256 principal);

    /// @notice #1923 (Codex #1929 r1 P1) — the loan is at or past its maturity,
    ///         so its lender side may no longer be sold. Mirrors
    ///         `OfferAcceptFacet.SaleLoanPastMaturity` (same name, no args ⇒ same
    ///         EVM selector), declared here rather than shared because the #1780
    ///         split left the two sale hosts as separate contracts — the same
    ///         reason `OfferExpired` / `OffsetActiveOnLoan` are declared twice.
    error SaleLoanPastMaturity();


    /// @dev #671 phase 2 (Codex #729 r4) — the buyer-side progressive-risk gate
    ///      for the direct Option-1 loan sale. Kept in its own frame so the
    ///      PairId locals + classification chain do not add to the already-deep
    ///      `sellLoanViaBuyOffer` stack (viaIR stack ceiling). Standing-consent
    ///      semantics — the buy offer carries no #662 acknowledgement for this
    ///      loan's assets. Behind the off-by-default master switch.
    function _assertBuyerRiskAccess(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address buyer
    ) private view {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibRiskAccess.assertActorMayTransact(
            s,
            buyer,
            LibRiskAccess.PairId({
                lendAsset: loan.principalAsset,
                lendType: loan.assetType,
                lendTokenId: loan.tokenId,
                collAsset: loan.collateralAsset,
                collType: loan.collateralAssetType,
                collTokenId: loan.collateralTokenId,
                prepayAsset: loan.prepayAsset
            })
        );
    }

    /**
     * @notice Allows original lender to sell an active loan by accepting a new Lender Offer.
     * @dev Option 1: liam accepts Noah's Lender Offer. Transfers principal, forfeits accrued to treasury,
     *      calculates/pays shortfall if rates differ. Updates NFTs, loan lender.
     *      Callable only by original lender. Emits LoanSold.
     * @param loanId The active loan ID to sell.
     * @param buyOfferId The new Lender Offer ID from Noah.
     */
    function sellLoanViaBuyOffer(
        uint256 loanId,
        uint256 buyOfferId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — selling a loan routes funds back
        // to msg.sender (the lender exiting early).
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Strategic flow — authority binds to current lender-side NFT owner.
        LibAuth.requireLenderNftOwner(loan);
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // #951 (Codex #959 round-4) — a live Option-2 sale listing has already
        // native-locked the lender NFT and pinned an immutable buyer-facing
        // offer. Letting Option-1 (direct swap-in) re-anchor `loan.lender` while
        // that listing is open would double-sell the same position: the Option-2
        // buyer could still accept the stale vehicle. Require the seller to cancel
        // the listing first. See LenderSaleVehicleRedesign.md (D4).
        if (s.loanToSaleOfferId[loanId] != 0)
            revert SaleOfferAlreadyExists();
        // NFT rental lender-sale requires NFT custody transfer — not supported in Phase 1
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidSaleOffer();

        // #1503 PR-E (design item 11) — the incoming lender never
        // underwrote this loan, so the sale is an ADMISSION and must
        // clear the same solvency floor the loan's own admission did.
        // Without it a lender watching collateral fall could hand an
        // already-underwater (possibly same-block liquidatable) position
        // to a buyer whose standing offer was authored for a FRESH,
        // comfortably over-collateralized position — priced off principal
        // and accrued interest, which say nothing about the shortfall.
        // Checked before any compliance / vault work so a doomed sale
        // reverts cheaply.
        LibSaleSolvency.assertSaleSolvent(loanId);

        // Per-asset pause: direct lender swap-in is a creation path (Noah
        // steps into new exposure without going through acceptOffer). The
        // exit path for the old lender is still covered via claim/repay.
        LibFacet.requireAssetNotPaused(loan.principalAsset);
        LibFacet.requireAssetNotPaused(loan.collateralAsset);

        LibVaipakam.Offer storage buyOffer = s.offers[buyOfferId];
        if (
            buyOffer.offerType != LibVaipakam.OfferType.Lender ||
            buyOffer.accepted
        ) revert InvalidSaleOffer();
        // #1503 (design item 10) — GTT expiry. This path checked the offer's
        // TYPE and `accepted` flag but never its deadline, so a lender offer
        // past `expiresAt` and not yet permissionlessly cancelled stayed
        // consumable: the seller could withdraw the creator's still-vaulted
        // principal and mark the offer accepted AFTER the window that creator
        // consented to had closed. Every fill / match path enforces this
        // lazily (the storage row outlives `expiresAt` — there is no keeper
        // sweep), and this one was the gap.
        //
        // NUMBERING — this comment said "item 8" until it was corrected.
        // #1503 renumbered mid-thread on 2026-07-31: two instant-sell items
        // were inserted as 6 and 7, pushing NFT-identity / duration / expiry
        // to 8 / 9 / 10. Expiry is 10. The collateral-identity guard further
        // down is the real item 8, so the stale label had one file using
        // "item 8" for two different consent guards. The issue BODY still
        // carries the pre-renumber numbers; the comments from 2026-07-31
        // 09:44 onward carry these.
        //
        // Placed before the offset-vehicle check and every lien release or
        // vault movement below, so an expired offer costs the caller a cheap
        // revert and moves nothing. Routes through `LibVaipakam.isOfferExpired`
        // so the GTC sentinel (`expiresAt == 0`, never expires) keeps living in
        // one place rather than being re-derived here.
        if (LibVaipakam.isOfferExpired(buyOffer)) {
            revert OfferExpired(buyOfferId, buyOffer.expiresAt);
        }
        // #1001 (S3, Codex #1070 r5 P2) — a linked Preclose Option-3 offset offer
        // is a Lender offer, so it would otherwise pass the shape check above and
        // be consumable here. Consuming it via the direct swap-in marks it
        // accepted + burns its position NFT WITHOUT the `acceptOffer` auto-complete
        // hook that fires `completeOffsetInternal` — stranding the offset link +
        // the borrower NFT lock. An offset offer must settle only through the
        // direct `acceptOffer` path; reject it as a sale vehicle here, same as the
        // matcher rejects it (`OffsetVehicleNotMatchable`).
        if (s.offsetOfferToLoanId[buyOfferId] != 0) revert InvalidSaleOffer();
        // #1503 design item 21 — and note this is a DIFFERENT question from the
        // line above, which is why the gap survived review: that one asks "is the
        // OFFER I am consuming an offset vehicle" (`offsetOfferToLoanId[offerId]`),
        // this one asks "does the LOAN I am selling have a live offset on it"
        // (`loanToOffsetOfferId[loanId]`). Same mapping family, opposite subject;
        // the first reads like the second at a glance.
        //
        // The listing sibling has refused this since #1001 (S3, Codex #1070) for
        // the same reason, which applies at least as sharply here: a sale is a
        // second SETTLEMENT of a loan that already has one in flight, and the two
        // would race. Note what this is NOT — a bare transfer of the lender NFT
        // stays allowed on purpose, because the offset locks only the borrower
        // position and `_completeOffsetImpl` re-anchors to whoever holds the
        // lender side when it settles. Ownership changing is fine; a second
        // settlement is not.
        //
        // The direct sale is the sharper case because it settles inside a single
        // transaction — there is no listing window during which anyone could
        // notice the offset and cancel.
        //
        // Every other mutator of this class already guards it: `PrecloseFacet`
        // (a second offset), `PrepayListingFacet`, and `createLoanSaleOffer`. This
        // path was the one that did not.
        if (s.loanToOffsetOfferId[loanId] != 0) revert OffsetActiveOnLoan();
        // T-407-C (#566) Codex P2 — the loan sale consumes the buy offer
        // in full, so it must be a clean SINGLE-VALUE, UNFILLED offer:
        //   • Ranged (effective amountMax > amount): the offer pre-vaults
        //     and liens the ceiling, but the refund below only returns
        //     `amount - principal`, stranding `amountMax - amount` in the
        //     seller's vault with no cancel path (the offer is marked
        //     accepted here).
        //   • Partially filled (amountFilled > 0): only the residual is
        //     vaulted, so the full-amount principal + refund withdrawals
        //     would revert, or over-consume the seller's unrelated free
        //     balance.
        // Both shapes stay usable for ordinary matching — just not as a
        // loan-sale vehicle. With this guard the existing refund
        // (`amount - principal`) is provably exact (vault holds exactly
        // `amount`).
        {
            uint256 effMax = buyOffer.amountMax == 0
                ? buyOffer.amount
                : buyOffer.amountMax;
            if (effMax != buyOffer.amount || buyOffer.amountFilled != 0) {
                revert InvalidSaleOffer();
            }
        }
        // Enforce same asset types as original loan (README General Rules: lending, collateral, prepay)
        if (buyOffer.lendingAsset != loan.principalAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAsset != loan.collateralAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAssetType != loan.collateralAssetType)
            revert InvalidSaleOffer();
        if (buyOffer.prepayAsset != loan.prepayAsset) revert InvalidSaleOffer();

        // #1912 (#1503 items 7 + 8) — BUYER-side term binding. Everything above
        // this point, and the borrower-favourability block below, protects
        // `alice` from Noah's terms. Nothing protected Noah from the LOAN's.
        //
        // The listed route has no such gap, and not because it carries more
        // comparisons: `EarlyWithdrawalFacet._buildSaleParams` MIRRORS these
        // exact fields off the loan onto the sale vehicle, so its buyer reviews
        // and signs the position's real behaviour and cannot be handed
        // anything else. That mirroring is #1503 design item 23, landed in
        // #1779. Items 7 + 8 are the same defect on this route, and it stayed
        // open because this path consumes an offer authored for a HYPOTHETICAL
        // loan — there is nothing to mirror onto, so the terms must be
        // reconciled instead.
        //
        // ProjectDetailsREADME §9 makes closing it mandatory rather than
        // optional: "These rules bind both sale routes identically. A rule that
        // applied to the direct sale and not to the listed sale's completion
        // would let the same position be sold on different economics depending
        // on which door it left by." Leaving this open IS that divergence — the
        // same position sells with the buyer's behavioural terms honoured
        // through one door and discarded through the other.
        //
        // EQUALITY, not a favourability direction. The listed route's buyer
        // receives precisely the loan's values, so a directional rule here
        // would let this door deliver terms the other door structurally never
        // could — parity is the requirement, and parity is exact. That also
        // rules out the "buyer inherits something stricter, so allow it"
        // shortcut: a buyer who authored `allowsPartialRepay = true` and
        // silently receives `false` still holds a position they did not
        // author.
        //
        // Safe as a one-shot comparison because all four behavioural terms are
        // IMMUTABLE for the loan's lifetime — `LoanFacet` writes them once at
        // initiation and nothing in `src/` writes them again (the same
        // reasoning `_buildSaleParams` records for mirroring at listing time
        // rather than binding at acceptance). Principal is the field that
        // genuinely needs a live read; these are not like principal.
        //
        // `creatorFull` / `creatorMaxCStar` are deliberately NOT here.
        // `_buildSaleParams` does not mirror them either, so binding them on
        // this route alone would break the same parity rule in the opposite
        // direction. Full-tariff authorization on a sale is its own question
        // (#1503 item 22), not part of this one.
        //
        // MAINTENANCE, stated plainly because the honest version is weaker
        // than the one a reader will assume. This set is enumerated by hand
        // and there is NO compiler-enforced pin to `_buildSaleParams`. Each
        // field below has an execution test that fails if its check is
        // removed, and a further test asserts a listed-route vehicle passes
        // every check here — but that direction only catches this route
        // binding MORE than the other, not less. A behavioural term added to
        // `_buildSaleParams` and forgotten here fails no test, which is
        // exactly how items 7 + 8 outlived item 23's fix. Adding one there
        // means adding it here in the same diff; a source-text guard was
        // considered and rejected for the reason `CLAUDE.md` records about
        // the withdrawn step-4c parser — a check that cannot actually prove
        // the property reports a green it has not earned, which on a
        // consent boundary is worse than no check.
        if (buyOffer.useFullTermInterest != loan.useFullTermInterest)
            revert SaleOfferTermsDisagree(0);
        if (buyOffer.allowsPartialRepay != loan.allowsPartialRepay)
            revert SaleOfferTermsDisagree(1);
        if (buyOffer.allowsPrepayListing != loan.allowsPrepayListing)
            revert SaleOfferTermsDisagree(2);
        if (buyOffer.periodicInterestCadence != loan.periodicInterestCadence)
            revert SaleOfferTermsDisagree(3);
        // Item 8 — collateral / lending-asset IDENTITY. A no-op on ERC-20 legs
        // (both sides 0) and load-bearing on NFT legs, where a lender offer's
        // `collateralTokenId` is a specific demand rather than a wildcard:
        // `OfferAcceptFacet` pulls the borrower's collateral by exactly that id,
        // and its acceptance binding already enforces it as
        // `OfferTermsMismatch(11)` on the ordinary origination path.
        if (buyOffer.collateralTokenId != loan.collateralTokenId)
            revert SaleOfferTermsDisagree(4);
        if (buyOffer.collateralQuantity != loan.collateralQuantity)
            revert SaleOfferTermsDisagree(5);
        if (buyOffer.tokenId != loan.tokenId)
            revert SaleOfferTermsDisagree(6);
        if (buyOffer.quantity != loan.quantity)
            revert SaleOfferTermsDisagree(7);

        // Borrower-favorability + buyer-exposure: Noah's terms must not worsen
        // alice's position, and the position must fit inside what Noah authored
        // (README Section 9).
        {
            // #1923 (#1503 item 9) — the buyer's authored duration is a CEILING
            // on how long they consent to be locked, NOT the loan's term. A sale
            // never moves the loan's maturity (fixed at origination), so the
            // buyer inherits the remaining exposure as-is; it must fit within
            // their authored duration. This replaces the old
            // `buyOffer.durationDays > remainDays` check, which was inverted —
            // it refused offers LONGER than remaining (harmless: the loan is not
            // re-termed) while admitting a SHORT offer into a long position, the
            // over-exposure this item is about. One-directional like the
            // inherited risk-terms / fee rules: a shorter remaining term than
            // authored is the better position and stays sellable. Measured off
            // the maturity TIMESTAMP, not floored whole days, so a fill cannot
            // slip up to ~24h past the buyer's authored window.
            uint256 maturity =
                uint256(loan.startTime) + uint256(loan.durationDays) * 1 days;
            // #1923 (Codex #1929 r1 P1) — refuse a sale at or past maturity.
            // The one-directional check below floors remaining exposure at 0, so
            // without this an overdue-but-still-Active loan (throughout grace, or
            // after it until default is triggered) would pass EVERY positive
            // offer and let the seller hand off an already-matured position. The
            // old `durationDays > remainDays` guard caught this incidentally
            // (remainDays hit 0, so any positive offer reverted); the maturity
            // check makes it explicit, matching the listed route's
            // `SaleLoanPastMaturity` refusal at the same boundary.
            if (block.timestamp >= maturity) revert SaleLoanPastMaturity();
            uint256 liveRemainingSecs = maturity - block.timestamp;
            uint256 authoredSecs = uint256(buyOffer.durationDays) * 1 days;
            if (liveRemainingSecs > authoredSecs)
                revert SaleExposureExceedsAuthoredDuration(
                    liveRemainingSecs, authoredSecs
                );
            if (buyOffer.collateralAmount > loan.collateralAmount)
                revert InvalidSaleOffer();
        }

        // #1921 (#1503 item 5) — resolve the loan's CURRENT borrower once. The
        // borrower position NFT may have changed hands since origination, so the
        // stored `loan.borrower` is stale; both the self-buy guard and the
        // compliance recheck below key on the live holder. Same resolution the
        // listed route does in `LoanFacet.initiateLoan` (Codex #959 round-8 P1).
        address currentBorrower = LibERC721.ownerOf(loan.borrowerTokenId);
        // Reject the loan's OWN current borrower buying the lender side of their
        // own debt: that migrates the lender onto the borrower, leaving an Active
        // loan with `lender == borrower` (a party owing itself — breaks
        // claim/repay accounting, after which `RepayFacet` rejects that wallet's
        // ordinary repayment). The exit for a borrower is repay / preclose, never
        // buying their own debt's lender side. The listed route enforces this in
        // `LoanFacet.initiateLoan`; this direct route had no equivalent.
        if (buyOffer.creator == currentBorrower)
            revert SaleBuyerIsBorrower(loanId, currentBorrower);

        // ── Sanctions & KYC: new lender (Noah) must pass normal initiation checks ─
        // #1921 — validate the buyer against the loan's LIVE counterparty (the
        // current borrower holder), not the stale `loan.borrower`. The generic
        // offer KYC/country checks cover only lender-vs-buyer, not the borrower
        // whose live loan the buyer is stepping into. No-op on the retail deploy
        // (KYC/country off); load-bearing on the industrial fork where a
        // borrower's tier/country may have degraded since origination. Mirrors
        // the Option-2 (`initiateLoan`) sale-vehicle compliance recheck.
        LibCompliance.enforceCountryAndKyc(
            address(this),
            buyOffer.creator,
            currentBorrower,
            loan.principalAsset,
            loan.principal,
            loan.collateralAsset,
            loan.collateralAmount
        );

        // #671 phase 2 (Codex #729 r4) — re-gate the BUYER against the loan's
        // asset pair. This direct Option-1 sale bypasses acceptOffer /
        // initiateLoan, so the accept-time progressive-risk gate in LoanFacet
        // never runs; without this re-check a buy offer authored before the gate
        // was enabled (or whose creator has since down-tiered, revoked the pair
        // consent, or gone stale after a terms bump) could still step into an
        // illiquid- or mid-tier-backed live loan. Extracted to a helper so the
        // PairId locals do not add to this function's (already deep) stack frame.
        _assertBuyerRiskAccess(s, loan, buyOffer.creator);

        // Snapshot pre-existing heldForLender before any new shortfall deposits.
        uint256 priorHeld = s.heldForLender[loanId];

        // ── Net settlement (README Section 9, Option 1) ────────────────────
        // Noah's principal is the only inflow.  liam's share (principal minus
        // his cost) is paid out net; treasury cut and Noah's shortfall deposit
        // come from the same bucket — liam never needs to pre-approve tokens.
        //   liamCost    = max(accrued, shortfall)
        //   treasuryCut = max(accrued - shortfall, 0)   (unused forfeited accrued)
        //   toNoahHeld  = shortfall                     (compensates Noah)
        //   toLiam      = principal - liamCost
        // Unified seconds-based precision: both accrued and remaining use
        // SECONDS_PER_YEAR so any sub-day remainder is preserved and rounding
        // is symmetric across the two sides of the net settlement.
        // #641 — accrued/remaining split reads the interest clock (post-partial
        // origin + remaining term), not the immutable term tuple.
        uint256 accrualStart = LibVaipakam.interestAccrualStartOf(loan);
        uint256 elapsed = block.timestamp - accrualStart;
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;

        // #1503 item 28 — the FORFEITURE clock starts at the point this lender
        // has already been PAID through, falling back to the accrual origin only
        // for a lender who has never been paid at all. NOT the later of the two:
        // the obligation clock re-bases on events that pay nobody (Codex r4 P1).
        // Identical treatment to the listed route in `EarlyWithdrawalFacet`: the
        // accrual clock still spans periods the borrower has already paid for, so
        // charging from it bills the seller for interest they have received. Both
        // routes must price the same forfeiture or the asymmetry is arbitrary.
        // See {LibEntitlement.forfeitureAccrualStart} for why this is a window
        // and not an amount.
        uint256 forfeitFrom = LibEntitlement.forfeitureAccrualStart(loanId, accrualStart);
        uint256 forfeitSecs =
            block.timestamp > forfeitFrom ? block.timestamp - forfeitFrom : 0;
        uint256 accrued = (loan.principal * loan.interestRateBps * forfeitSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 originalRemainingInterest = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 newRemainingInterest = (loan.principal *
            buyOffer.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);

        uint256 shortfall = newRemainingInterest > originalRemainingInterest
            ? newRemainingInterest - originalRemainingInterest
            : 0;
        uint256 liamCost = accrued > shortfall ? accrued : shortfall;
        uint256 treasuryCut = accrued > shortfall ? accrued - shortfall : 0;

        // #1923 (#1503 item 15) — EXACT match, not a floor. The buy offer is
        // single-valued (ranged/partial rejected above) and is consumed WHOLE
        // (marked accepted + position-NFT burned below), so an offer whose
        // amount exceeds the principal would place the buyer in a smaller
        // position than they authored while burning their offer. The listed
        // route builds its vehicle at exactly `loan.principal`, so an
        // over-funded fill here is the door-dependent divergence §9 forbids.
        // `amount < principal` still cannot fund the sale; `amount > principal`
        // is now refused rather than silently refunded — which makes the old
        // excess-refund path below unreachable, so it has been removed.
        if (buyOffer.amount != loan.principal)
            revert SaleAmountNotExactPrincipal(buyOffer.amount, loan.principal);
        // If liam's cost exceeds what Noah brings, net settlement cannot
        // complete — liam would owe tokens we never collected from him.
        if (liamCost > loan.principal) revert RateShortfallTooHigh();

        // T-407-C (#566) Codex P1 — release the buy offer's offer-principal
        // lock before consuming its principal. The Lender buy offer
        // pre-vaulted its principal at create, encumbered in the same
        // aggregate the #565 withdraw chokepoint reads. This sale
        // terminally consumes the offer (accepted = true + position-NFT
        // burn below), so release the lock in full BEFORE the principal +
        // excess withdrawals — otherwise the chokepoint sees free balance
        // = 0 and bricks the first withdraw. The NFT-burn at the end of
        // this function is too late to unblock these withdraws.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                buyOfferId
            ),
            bytes4(0)
        );

        // #1123 (Codex #1126 r2 P2) — fail-closed movement gate BEFORE the buyer's
        // vault operations. On the DIRECT sale path a flagged BUYER is BLOCKED (user
        // decision 2026-07-09): acquiring a position is a value-receiving action, so
        // BOTH parties are gated here — a clean `SanctionedAddress` revert ahead of
        // the buyer's principal pull below (whose vault resolution would otherwise
        // brick a flagged buyer with an opaque error). `from` is the LIVE seller.
        // (The accepted-sale COMPLETION path uses the seller-block/buyer-register
        // sale gate instead, matching its #831 frozen-buyer-completes semantics.)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ProfileFacet.enforcePositionMoveNotSanctioned.selector,
                LibERC721.ownerOf(loan.lenderTokenId),
                buyOffer.creator
            ),
            bytes4(0)
        );

        // Pull Noah's principal into the diamond in a single withdraw,
        // then fan out to liam / treasury / Noah's heldForLender.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                buyOffer.creator, // Noah
                loan.principalAsset,
                address(this),
                loan.principal
            ),
            VaultWithdrawFailed.selector
        );

        // #1817 (Codex #1819 r3 P1) — checkpoint the buyer at the DEBIT
        // trough, before any re-credit. The principal pull above can take
        // their vaulted VPFI to zero, and the single post-credit stamp below
        // would then observe old-positive → final-positive: the staker
        // lifecycle never resets and the day's minimum never records the
        // zero, so re-credited held VPFI would inherit the buyer's pre-sale
        // tier tenure. Stamping the trough makes the zero observable; the
        // final stamp after the credits remains. Since #1923 pinned
        // `amount == principal` (item 15), this principal pull is the buyer's
        // ONLY debit — there is no oversized-offer refund after it — so this IS
        // the last-debit trough (the former #1819 r4 excess re-stamp is gone
        // with that path). LOCAL rollup (r7 P2): this is an INTERMEDIATE
        // checkpoint — the buyer's final stamp in the settlement block carries
        // the broadcast, and a per-checkpoint CCIP push would charge the shared
        // budget once per dip and could revert the sale when it covers the
        // first message but not the second.
        if (loan.principalAsset == s.vpfiToken) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.restampUserVpfiLocalInternal.selector,
                    buyOffer.creator
                ),
                bytes4(0)
            );
        }

        uint256 toLiam = loan.principal - liamCost;
        if (toLiam > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, toLiam);
        }
        LibFacet.transferToTreasury(loan.principalAsset, treasuryCut);
        LibFacet.depositForNewLender(
            loan.principalAsset,
            buyOffer.creator,
            shortfall,
            loanId
        );

        // #1923 (#1503 item 15) — no excess to refund. The exact-match guard
        // above pins `buyOffer.amount == loan.principal`, so the principal pull
        // is the buyer's ONLY vault debit; the trough checkpoint at that pull
        // (above) is therefore their last debit, and no post-refund re-stamp is
        // needed. The former oversized-offer refund + its #1817 r4 re-stamp are
        // gone with the over-funding path they served.

        // #597 — release the old lender's held-for-lender VPFI reservation
        // BEFORE the physical migration withdraws it from their vault below:
        // the #565 withdraw chokepoint would otherwise see the held as
        // encumbered and brick the withdraw. `loan.lender` is still the old
        // lender here (migrated below). No-op for a non-VPFI / never-reserved
        // loan. The full held is re-reserved on the new lender after the
        // position migrates (see end of this block).
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);
        // #1503 design item 17 — release the seller's standing-intent live-
        // principal cap, exactly as the listed route has done since #393 v1-b.
        // The seller EXITS the loan here too: they take the sale proceeds and
        // hand the position to the buyer, so holding their cap until the buyer
        // eventually claims strands it against a claim the buyer might never
        // make. Keyed off the ORIGINATING intent so it frees the original
        // owner's counter and deletes the marker.
        //
        // Gated on the same cheap per-loan origin check, so a loan that came
        // from no intent skips the cross-facet hop entirely — no wasted gas, and
        // no dependency on `LenderIntentFacet` being routed.
        //
        // This is the guard-remembered-twice shape recorded on #1503: the
        // release exists, is correct, and was simply never applied to the direct
        // sibling — like the GTT expiry (#1772) and the offset guard (#1813).
        //
        // ...UNLESS the buyer IS the origin owner (Codex #1818 r1 P1): selling
        // to yourself through your own standing buy offer leaves you the lender
        // of a live intent loan, and releasing here would free its full
        // principal from your `MAX_EXPOSURE` cap while the exposure is still
        // real — a self-trade that mints headroom. The marker and the counter
        // are retained; the loan simply remains what it was, an intent fill
        // held by its origin owner.
        if (
            s.intentOrigin[loanId].owner != address(0) &&
            s.intentOrigin[loanId].owner != buyOffer.creator
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector, loanId
                ),
                bytes4(0)
            );
        }
        // #998 S10 Class B (Codex fresh-round P2) — migrate the dedicated
        // active-held reservation off the OLD lender NOW, BEFORE the `priorHeld`
        // withdrawal below: `vaultWithdrawERC20` subtracts `encumbered[oldLender]`,
        // so a still-locked active-held reservation would revert a clean/de-listed
        // holder's sale. Moves the aggregate old → buyer (reads the old lender from
        // the live loan, still un-migrated here); covers every asset. No-op when
        // nothing was parked.
        LibEncumbrance.migrateActiveHeld(loanId, buyOffer.creator);

        // Migrate only the pre-existing heldForLender from old lender's vault to new lender's.
        // priorHeld was snapshotted before any shortfall deposits in this transaction.
        if (priorHeld > 0) {
            address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
            // #597 Codex #672 P1 — withdraw the held from the STORED `loan.lender`,
            // NOT `msg.sender`. The held was deposited into `loan.lender`'s vault
            // at accrual and the #597 reservation (released just above) is keyed
            // there too. After a plain lender-NFT transfer (pre-consolidation),
            // `msg.sender` (the current NFT owner accepted by
            // `requireLenderNftOwner`) ≠ `loan.lender`; sourcing from `msg.sender`
            // would migrate the caller's OWN VPFI and leave the stored lender's
            // released-but-not-moved held unencumbered + drainable. In the common
            // sell-your-own-loan case `msg.sender == loan.lender` so this is
            // unchanged. (`completeLoanSale` already uses `originalLender`.)
            //
            // #597 Codex #672 P2 — the stored `loan.lender` may have been
            // sanctions-flagged after a plain lender-NFT transfer; they are
            // LOSING custody (their held VPFI is pushed OUT to the new lender),
            // so the Tier-1 vault gate must not brick this Tier-2 sale for the
            // unflagged seller. Open the address-scoped exemption around ONLY
            // this from-side withdrawal (same primitive as the #594 consolidation
            // move). The host is `nonReentrant`; cleared immediately after.
            s.consolidationMoveFromUser = loan.lender;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.lender, // stored (old) lender — where the held VPFI sits
                    payAsset,
                    address(this),
                    priorHeld
                ),
                VaultWithdrawFailed.selector
            );
            s.consolidationMoveFromUser = address(0);
            // #1817 (Codex #1819 r6 P1) — checkpoint the DEPARTED lender at
            // their post-withdraw balance NOW, between the held debit and the
            // buyer-side redeposit. In a SELF-SALE (the stored lender selling
            // into their own standing buy offer) the redeposit below returns
            // the very same vault to positive, and a stamp taken only after
            // the migration observes positive -> positive across a real zero
            // - the staker lifecycle never resets. For a third-party sale
            // this is the same post-mutation stamp the settlement block used
            // to take, moved to the mutation site (where every other VPFI
            // movement stamps). In a SELF-SALE this stamp is INTERMEDIATE —
            // the same user's final buyer stamp follows — so it rolls up
            // LOCALLY there (r7 P2: one broadcast per party per sale); for a
            // third-party seller it is their final movement and broadcasts.
            if (loan.principalAsset == s.vpfiToken) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        loan.lender == buyOffer.creator
                            ? ConsolidationFacet.restampUserVpfiLocalInternal.selector
                            : ConsolidationFacet.restampUserVpfiInternal.selector,
                        loan.lender
                    ),
                    bytes4(0)
                );
            }
            address newVault = LibFacet.getOrCreateVault(buyOffer.creator);
            IERC20(payAsset).safeTransfer(newVault, priorHeld);
            // T-051 — Diamond-side transfer to new lender's vault
            // ticks the protocolTrackedVaultBalance counter.
            LibVaipakam.recordVaultDeposit(buyOffer.creator, payAsset, priorHeld);
        }

        // #1123 — fail-closed position-movement gate BEFORE the burn/mint
        // migration: a registered-flagged current lender holder (or buyer) can't
        // move the position via this sale vehicle during an oracle outage. `from`
        // is the LIVE lender-position holder, captured before `migrateLenderPosition`
        // rewrites `loan.lender`/`loan.lenderTokenId`.
        // #1123 — the movement gate for this direct sale ran BEFORE the buyer's
        // vault operations above (block-both; see the comment at the principal
        // pull). No second gate needed here.
        // #1817 (Codex #1819 r1 P1) — snapshot the STORED lender before the
        // migration rewrites `loan.lender`: the held VPFI was withdrawn from
        // THEIR vault above (the #672 P1 rule), so theirs is the accumulator
        // the restamp below must refresh. After a plain lender-NFT transfer
        // (pre-consolidation) `msg.sender` is the current NFT holder, whose
        // vault this sale did not touch.
        address storedLender = loan.lender;
        // Migrate lender position: burn old NFT + mint new LoanInitiated NFT
        // for Noah, update loan.lender and loan.lenderTokenId in one place.
        // (#998 S10 Class B — `migrateLenderPosition` carries the dedicated
        // active-held reservation to the buyer internally.)
        LibLoan.migrateLenderPosition(loanId, buyOffer.creator);

        // #597 — re-reserve the held-for-lender VPFI on the NEW lender, where it
        // now physically lives (pre-existing `priorHeld` migrated above + this tx's
        // `shortfall` deposit). `loan.lender` is now the new lender. Released to the
        // new lender at claim. Gated on VPFI (held is in the principal asset;
        // NFT-rental prepay can't be VPFI — D-2).
        //
        // #998 S10 Class B (Codex fresh-round P2) — re-reserve only the
        // NON-active-held slice: the Class B active-held portion
        // (`heldForLenderEncumbered`) was already migrated to the buyer in its
        // dedicated ledger above, so re-reserving the FULL `heldForLender` here
        // would DOUBLE-count that slice and understate the buyer's VPFI free
        // balance until claim. The active portion is always a subset of the total
        // held (each park ticks both), so the subtraction can't underflow.
        if (loan.principalAsset == s.vpfiToken) {
            uint256 nonActiveHeld = s.heldForLender[loanId] -
                s.heldForLenderEncumbered[loanId];
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, nonActiveHeld
            );
            // #1503 item 27 (#1817) — the buyer's post-sale checkpoint.
            // `loan.lender` is the buyer after the migration above; their
            // vault always moved on this route (the principal debit, plus
            // the held credit when any was held). The DEPARTED lender's
            // stamp happens at the held-withdrawal site itself (r6 P1, gated
            // on priorHeld > 0 by that block), so a self-sale's
            // mid-transaction zero is observed before the redeposit.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.restampUserVpfiInternal.selector,
                    loan.lender
                ),
                bytes4(0)
            );
        }

        // Old lender forfeits interaction rewards to treasury; new lender
        // gets a fresh entry covering the residual loan window. #1067 — routed
        // through the `transferLenderRewardEntry` self-hook so the O(1) transfer
        // body lives on InteractionRewardsFacet, off this EIP-170-tight facet.
        // ATOMIC with the settlement since #1503 item 12 — see `_rewardHook`
        // for why a failure here must not settle silently.
        _rewardHook(
            abi.encodeWithSelector(
                InteractionRewardsFacet.transferLenderRewardEntry.selector,
                loanId,
                buyOffer.creator
            )
        );

        // Mark buyOffer accepted
        buyOffer.accepted = true;
        LibMetricsHooks.onOfferAccepted(buyOffer.id);

        // Burn the consumed offer's position NFT (stale "Offer Created" artifact)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                buyOffer.positionTokenId
            ),
            NFTBurnFailed.selector
        );

        emit LoanSold(
            loanId,
            msg.sender,
            buyOffer.creator,
            shortfall,
            loan.lenderTokenId,
            loan.interestRateBps,
            loan.durationDays,
            uint64(loan.startTime + loan.durationDays * 1 days)
        );
    }

    /// @dev #1067 — reward transfer self-call; the O(1) transfer body lives
    ///      on {InteractionRewardsFacet}. #1503 item 12 made it atomic with
    ///      the settlement (a failed call bubbles) — see the body comment.
    function _rewardHook(bytes memory data) private {
        // #1503 item 12 — ATOMIC with settlement, no longer best-effort; see
        // the listed route's twin for the full rationale (the quote's
        // forfeiture disclosure makes this a kept promise, and the transfer
        // body cannot revert on a properly-cut diamond, so what bubbles is
        // deploy drift — the case that must not settle silently).
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(32, ret), mload(ret))
                }
            }
            revert RewardMigrationFailed();
        }
    }
}
