// src/facets/EarlyWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibSaleListing} from "../libraries/LibSaleListing.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LenderIntentFacet} from "./LenderIntentFacet.sol";
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
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {SaleExitVerdictFacet} from "./SaleExitVerdictFacet.sol";

/**
 * @title EarlyWithdrawalFacet
 * @author Vaipakam Developer Team
 * @notice Lender early-withdrawal by the LISTED route — offering the loan
 *         position for sale and letting a new lender take it (Option 2 per
 *         README §9).
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental lender-sale requires NFT custody
 *      transfer — not supported in Phase 1).
 *
 *      Option 1 — the DIRECT route, {EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer}
 *      — moved to its own facet in #1780 for EIP-170 headroom. Both routes
 *      still route through the same Diamond and read the same storage; only
 *      the runtime bytecode is split. See that facet's header for why the
 *      seam runs between the routes rather than through the listed route's
 *      two halves.
 *
 *      Option 2 — two-step, and the whole of this facet:
 *        a) {createLoanSaleOffer}: liam creates a borrower-style sale
 *           offer linked to the live loan via `saleOfferToLoanId`.
 *        b) A new lender accepts the sale offer (via {OfferFacet.acceptOffer},
 *           which atomically calls {completeLoanSale}). The live loan's
 *           lender field is updated to the new lender, new NFTs are minted,
 *           old NFTs burned. The seller's earned-unpaid interest stays a
 *           seller claim on the loan (#1209, {LibInterestLedger}).
 *
 *      Sanctions/KYC enforced via {LibCompliance}. The borrower and loan
 *      terms are unchanged — only the lender relationship transfers.
 */
contract EarlyWithdrawalFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan sale offer is created and linked to a live loan (Option 2, step 1).
    /// @param loanId The live loan being sold.
    /// @param saleOfferId The borrower-style offer created to execute the sale.
    /// @custom:event-category state-change/loan-mutation
    event LoanSaleOfferLinked(
        uint256 indexed loanId,
        uint256 indexed saleOfferId
    );

    /// @notice Emitted when a loan sale is completed via Option 2.
    /// @custom:event-category state-change/loan-mutation
    event LoanSaleCompleted(
        uint256 indexed loanId,
        address indexed originalLender,
        address indexed newLender
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error SaleNotLinked();
    error SaleOfferNotAccepted();
    /// @notice #1001 (S3, Codex #1070) — the lender position can't be listed for
    ///         sale while a Preclose Option-3 offset offer is live on the loan;
    ///         cancel the offset to reopen this route — completing it instead
    ///         settles the loan, so there is no position left to list.
    error OffsetActiveOnLoan();
    /// @notice #951 (Codex #959 round-2) — Phase 1 lender-sale is limited to loans
    ///         with ERC-20 collateral. The sale vehicle escrows no fresh collateral
    ///         (it stays on the live loan), so the downstream accept / complete /
    ///         cancel paths would otherwise try to withdraw or refund an
    ///         ERC-721/ERC-1155 the vehicle never held. NFT-collateral lender-sale
    ///         is a tracked follow-up (#974); until then it is rejected at listing.
    error SaleOfferCollateralMustBeERC20();
    /// @notice #951 (redesign) — the lender position could not be consolidated to
    ///         its current holder at listing (it carries unreserved held-for-lender
    ///         VPFI, the #597 `_isExcludedLive` edge). Such a position can't have
    ///         its stored/economic identity unified, so it can't be safely sold
    ///         until the held VPFI is resolved. See LenderSaleVehicleRedesign.md D1.
    error SalePositionNotConsolidatable();
    /// @notice Lender-sale lifecycle (design item 1 + borrower action window) —
    ///         the seller-chosen listing window is outside the permitted
    ///         [MIN_SALE_LISTING_SECONDS, MAX_SALE_LISTING_SECONDS] range, or,
    ///         after clamping at the loan's maturity, shorter than the minimum
    ///         (a loan too close to maturity cannot be listed at all — matching
    ///         the Layer-1 rule that the sale rows go unavailable near
    ///         maturity rather than advertising an unfillable exit).
    error SaleListingWindowInvalid();
    /// @notice Lender-sale lifecycle (borrower action window) — a previous
    ///         listing on this loan ended without completing (cancel, expiry,
    ///         or teardown) and the relist cooldown has not passed. Surfaces
    ///         the timestamp at which listing re-opens so the frontend can say
    ///         when instead of just "no".
    error SaleRelistCooldownActive(uint64 availableAt);
    /// @notice The buy offer being consumed as a sale vehicle is past its GTT
    ///         deadline. Mirrors `OfferAcceptFacet.OfferExpired` (same name +
    ///         same args ⇒ same EVM selector), so a caller decodes identical
    ///         revert data whichever path refused the fill.
    error OfferExpired(uint256 offerId, uint64 expiresAt);
    // NOTE (#1503 PR-A, Codex #1505 r1): the live-maturity gate for a sale
    // fill lives in `OfferAcceptFacet` (`SaleLoanPastMaturity`), enforced at
    // ACCEPT time — before any buyer value moves. `_completeLoanSaleImpl`
    // deliberately does NOT re-check maturity: completion finishes what
    // acceptance already committed (buyer principal moved, temp vehicle loan
    // live), and refusing there would strand a committed buyer on the
    // documented manual-recovery path.

    /**
     * @notice Allows original lender to create a sale offer mimicking a Borrower Offer (Option 2).
     * @dev WARNING — front-ends MUST surface this to the caller before they
     *      sign: the lender-side position NFT for `loanId` is NATIVELY
     *      LOCKED against transfer/approve from the moment this call
     *      succeeds. The lock persists until either a new lender accepts
     *      the sale offer (at which point the NFT is burned and replaced
     *      via {completeLoanSale}) or the initiator cancels via
     *      {OfferFacet.cancelOffer}. During that window the holder cannot
     *      list, sell, transfer, or approve the NFT on any marketplace.
     *      See LibERC721.LockReason.EarlyWithdrawalSale.
     *
     *      liam creates offer for his loan position; new lender accepts via OfferFacet.acceptOffer.
     *      Terms: Remaining duration, same assets/collateral. Links offer to loan via new mapping.
     *      Callable only by original lender. No event here (emitted on acceptance in OfferFacet).
     *      Lifecycle (LenderEarlyWithdrawalUXDesign item 1 + borrower action
     *      window): every listing carries a MANDATORY finite expiry. The
     *      seller picks `listingSeconds` inside
     *      [MIN_SALE_LISTING_SECONDS, MAX_SALE_LISTING_SECONDS]; the
     *      resulting `expiresAt` is additionally clamped at the loan's own
     *      maturity so a listing can never be accepted inside the grace
     *      window. There is no never-expires option. A loan whose previous
     *      listing ended without completing is under a relist cooldown
     *      (`SALE_RELIST_COOLDOWN_SECONDS`) so the borrower's re-unblocked
     *      partial-repay / collateral-withdrawal paths get a real action
     *      window before the freeze can be re-established.
     * @param loanId The loan ID to sell.
     * @param interestRateBps The sale interest rate (may differ from original).
     * @param creatorRiskAndTermsConsent Consent for illiquid assets (if applicable).
     * @param listingSeconds Seller-chosen listing window in seconds; bounded
     *        to [MIN_SALE_LISTING_SECONDS, MAX_SALE_LISTING_SECONDS] and
     *        clamped at the loan's maturity.
     */
    function createLoanSaleOffer(
        uint256 loanId,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent,
        uint64 listingSeconds
    ) external nonReentrant whenNotPaused {
        _createLoanSaleOfferImpl(
            loanId, interestRateBps, creatorRiskAndTermsConsent, listingSeconds
        );
    }

    /**
     * @notice #1810 — list the lender position for sale, BOUND to the quote
     *         the seller reviewed. Identical to {createLoanSaleOffer} except
     *         that after the listing records its seller bounds
     *         (LibSaleListing.recordSellerBounds), the recorded figures are
     *         checked against what the seller was shown by
     *         `RiskPreviewFacet.quoteSellerBounds`, and the listing reverts on
     *         ADVERSE drift only: a floor below the reviewed one, or a held
     *         ceiling above it. Better-than-reviewed passes.
     *
     * @dev    Closes the quote→listing seam Codex raised as a P1 on #1812: the
     *         unbound entry recomputes both bounds from live state at mining
     *         time, so a borrower partial-repay (or parked interest) between
     *         the seller reading a quote and their transaction landing makes
     *         the listing record a WORSE floor/ceiling than reviewed — and the
     *         #1812 enforcement then faithfully protects the worse figure.
     *         #1812 binds listing→fill; this binds quote→listing.
     *
     *         ADDITIVE on purpose: {createLoanSaleOffer} stays routed and
     *         unchanged so the deployed frontend keeps working — changing its
     *         signature would mean a new selector plus an explicit Remove leg
     *         (the split-Diamond hazard CLAUDE.md documents) for no benefit.
     *
     *         The comparison runs AFTER the impl so it reads the very figures
     *         `recordSellerBounds` persisted — one computation, not a mirror
     *         of it (the #1801 lesson). A revert unwinds the whole listing
     *         atomically, lock and link included.
     *
     * @param loanId The loan ID to sell.
     * @param interestRateBps The sale interest rate (may differ from original).
     * @param creatorRiskAndTermsConsent Consent for illiquid assets (if applicable).
     * @param listingSeconds Seller-chosen listing window in seconds; bounded
     *        and clamped exactly as {createLoanSaleOffer}.
     * @param reviewedMinSellerNet The floor `quoteSellerBounds` showed the
     *        seller; the recorded floor must be at least this.
     * @param reviewedMaxHeld The held ceiling the seller reviewed; the
     *        recorded ceiling must not exceed it.
     */
    function createLoanSaleOfferBound(
        uint256 loanId,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent,
        uint64 listingSeconds,
        uint256 reviewedMinSellerNet,
        uint256 reviewedMaxHeld
    ) external nonReentrant whenNotPaused {
        _createLoanSaleOfferImpl(
            loanId, interestRateBps, creatorRiskAndTermsConsent, listingSeconds
        );
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 recordedFloor = s.saleListingMinSellerNet[loanId];
        if (recordedFloor < reviewedMinSellerNet) {
            revert ListingFloorBelowReviewed(recordedFloor, reviewedMinSellerNet);
        }
        uint256 recordedHeld = s.saleListingMaxHeldTransfer[loanId];
        if (recordedHeld > reviewedMaxHeld) {
            revert ListingHeldAboveReviewed(recordedHeld, reviewedMaxHeld);
        }
    }

    function _createLoanSaleOfferImpl(
        uint256 loanId,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent,
        uint64 listingSeconds
    ) private {
        // #1841 — every loan- and caller-level refusal of this route is
        // classified ONCE, in `SaleExitVerdictFacet`, which the lender exit
        // chooser reads too. It reverts with the first refusal, the same error
        // the verdict reports:
        //   • the global and per-asset pauses; the Tier-1 screens of the caller
        //     and of the lender-position holder (#819 — the proceeds settle to
        //     the holder, and a keeper caller would leave it unscreened);
        //   • who may list (Phase 6): the current lender-NFT owner, or a keeper
        //     authorised for the InitEarlyWithdraw action;
        //   • an Active loan with an ERC-20 principal (NFT rental sale is not
        //     supported) and ERC-20 collateral (#951 — the vehicle escrows no
        //     collateral; NFT-collateral sale is #974);
        //   • one live listing per loan (#951) and no live borrower offset
        //     (#1001 — a sale would be a second settlement racing the first;
        //     the offset is GTC and creator-cancellable only, #1814);
        //   • a loan before maturity, with at least `MIN_SALE_LISTING_SECONDS`
        //     of term left for the listing to run in (design item 1);
        //   • the relist cooldown after a listing ended unfilled (chaining
        //     bounded listings would recreate the indefinite borrower freeze
        //     the mandatory expiry removed; the error names when it lifts);
        //   • a position the consolidation below can move (#597 — unreserved
        //     held-for-lender VPFI cannot be consolidated);
        //   • the offer-duration cap on the remaining term, the vault version,
        //     and sale admission (#1503 PR-E — fail fast rather than publish a
        //     listing that could not lawfully be filled; the BINDING check is
        //     the accept-time one in `OfferAcceptFacet`).
        SaleExitVerdictFacet(address(this)).requireSaleExitOpen(
            loanId, msg.sender, SaleExitVerdictFacet.SaleRoute.Listing
        );
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // The exiting lender (current lender-NFT holder) is the sale offer's
        // real creator — proceeds and cancel authority bind to them, NOT to a
        // keeper caller (#951). The verdict has authorised the caller; a
        // keeper's action is charged against its service capacity (#1219).
        address seller = LibERC721.ownerOf(loan.lenderTokenId);
        if (msg.sender != seller && msg.sender != address(this)) {
            LibServiceCapacity.chargeKeeper();
        }

        // #951 (redesign D1) — consolidate the lender position to its CURRENT
        // holder (the seller) BEFORE listing, re-anchoring both `loan.lender` and
        // `heldForLender` to `ownerOf(lenderTokenId)`. This removes the
        // stale-`loan.lender` divergence that otherwise splits held-proceeds
        // custody (physically under the stored lender's vault) from accrued /
        // shortfall settlement and who `acceptOffer` pays (the current holder).
        // After this, `loan.lender == seller` for the entire sale, so completion
        // settles uniformly against one identity (see LenderSaleVehicleRedesign.md
        // D1/D2). `Tier1Strict` reverts on a sanctioned current holder — matching
        // this entry's Tier-1 gate. A position carrying unreserved held-for-lender
        // VPFI can't be consolidated (#597) and therefore can't be sold yet.
        if (
            LibConsolidation.consolidateToHolder(
                loanId,
                /* isLenderSide */ true,
                LibConsolidation.Ctx.Tier1Strict
            ) == LibConsolidation.Result.Skipped
        ) {
            revert SalePositionNotConsolidatable();
        }

        // Remaining term to the loan's EFFECTIVE maturity (the pause credit
        // included, #668 / #935); the verdict above refused a matured loan.
        uint256 remainingDays = LibLoanClock.remainingTermDays(loan);

        // Design item 1 — mandatory finite expiry, clamped at the loan's own
        // maturity. Validated in its own frame (viaIR stack ceiling).
        uint64 listingExpiresAt = _boundListingExpiry(loan, listingSeconds);

        // #951 (Codex #959) — native-lock the lender position NFT BEFORE the
        // cross-facet create hop, not after. Otherwise, if the seller is a
        // contract, a callback fired during offer creation could transfer the
        // still-unlocked lender NFT after auth/sanctions were checked but before
        // the lock lands, splitting cancel/proceeds authority (`saleOffer.creator`
        // stays the pre-callback seller) from the now-relocked position. Locking
        // first closes that window. Lock is released (and the NFT burned) in
        // completeLoanSale via migrateLenderPosition → LibERC721._burn, or
        // released in OfferFacet.cancelOffer. See LibERC721.LockReason.
        LibERC721._lock(loan.lenderTokenId, LibERC721.LockReason.EarlyWithdrawalSale);

        // Create mimicking Borrower Offer via cross-facet call.
        // collateralAmount is set to 0 because this is a lender-position sale,
        // not a real borrower posting collateral.  alice's collateral on the
        // live loan continues to back it after the lender transfer.  Setting 0
        // avoids requiring liam to post fresh capital he shouldn't need.
        // #671 — exempt this protocol-authored sale-vehicle create from the
        // risk-access gate: the offer's risk is the EXITING lender's, already
        // gated at the original loan. The transient is shared storage so it
        // survives the cross-facet `createOfferInternal` hop, and is cleared
        // immediately after (a non-false value at rest is a bug).
        s.saleVehicleCreate = true;
        uint256 saleOfferId = _submitSaleOffer(
            loan,
            seller,
            remainingDays,
            interestRateBps,
            creatorRiskAndTermsConsent,
            listingExpiresAt
        );
        s.saleVehicleCreate = false;
        s.loanToSaleOfferId[loanId] = saleOfferId;
        s.saleOfferToLoanId[saleOfferId] = loanId;
        // #1503 item 4 — record what the seller is agreeing to, so completion
        // is bound by it rather than by whatever the arithmetic comes to at the
        // acceptance block. Hosted in LibSaleListing so the direct route can
        // share the projection rather than re-deriving it — the two routes
        // duplicating settlement algebra is what #1659 had to repair.
        LibSaleListing.recordSellerBounds(
            s, loanId, interestRateBps, listingExpiresAt
        );
        // #951 v2 (Codex #959 bind-to-live) — no collateral snapshot is stored:
        // the buyer's accept binds `collateralAmount` `>=`-style against the LIVE
        // loan in `OfferAcceptFacet._bindTermsToOffer`, so a later collateral
        // reduction fails the buyer's floor structurally at the bind. Nothing to
        // snapshot here, nothing to clean up at completion/cancel.

        emit LoanSaleOfferLinked(loanId, saleOfferId);
    }

    /**
     * @dev Builds the 18-field `CreateOfferParams` struct in its own frame
     *      and fires the cross-facet call. Extracted from
     *      {createLoanSaleOffer} so `forge coverage --ir-minimum` doesn't
     *      pile every `loan.X` SLOAD onto the caller's stack.
     */
    function _submitSaleOffer(
        LibVaipakam.Loan storage loan,
        address creator,
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent,
        uint64 listingExpiresAt
    ) private returns (uint256 saleOfferId) {
        LibVaipakam.CreateOfferParams memory params = _buildSaleParams(
            loan,
            remainingDays,
            interestRateBps,
            creatorRiskAndTermsConsent
        );
        // Design item 1 — the mandatory bounded expiry rides the offer's own
        // #195 GTT machinery: `isOfferExpired` gates every accept/match
        // consumer, and the permissionless lazy-clear / teardown paths
        // reclaim the listing (and release the borrower-side holds) once it
        // passes. Never 0 (no GTC listings).
        params.expiresAt = listingExpiresAt;
        // #951 — call the INTERNAL create entry, not the external `createOffer`.
        // `createLoanSaleOffer` already holds the diamond-shared `nonReentrant`
        // guard, and the external `createOffer` re-enters that same guard via the
        // `address(this).call` hop → `ReentrancyGuardReentrantCall` every time.
        // `createOfferInternal` is `msg.sender == address(this)`-gated and takes
        // no reentrancy modifier (same pattern as `PrecloseFacet._submitOffsetOffer`).
        // The explicit `creator` is required because under `address(this).call`
        // `msg.sender` is the diamond — without it `offer.creator` would be
        // corrupted to the diamond instead of the exiting lender.
        bytes memory result = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferCreateFacet.createOfferInternal.selector,
                creator,
                params
            ),
            OfferCreationFailed.selector
        );
        saleOfferId = abi.decode(result, (uint256));
    }

    function _buildSaleParams(
        LibVaipakam.Loan storage loan,
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent
    ) private view returns (LibVaipakam.CreateOfferParams memory params) {
        params.offerType = LibVaipakam.OfferType.Borrower;
        params.lendingAsset = loan.principalAsset;
        params.amount = loan.principal;
        params.interestRateBps = interestRateBps;
        params.collateralAsset = loan.collateralAsset;
        params.collateralAmount = 0;
        params.durationDays = remainingDays;
        params.assetType = loan.assetType;
        params.tokenId = loan.tokenId;
        params.quantity = loan.quantity;
        params.creatorRiskAndTermsConsent = creatorRiskAndTermsConsent;
        params.prepayAsset = loan.prepayAsset;
        params.collateralAssetType = loan.collateralAssetType;
        params.collateralTokenId = loan.collateralTokenId;
        params.collateralQuantity = loan.collateralQuantity;
        // #183 (PR #187 Codex P1) — Phase 2 OfferCreateFacet rejects
        // `amountMax == 0` / `interestRateBpsMax == 0`
        // (and `collateralAmountMax == 0` for ERC20+ERC20 non-sale-
        // vehicle offers). Internal builders must ship explicit values
        // matching the floors to preserve single-value semantics
        // byte-identically. The sale vehicle's
        // `collateralAmountMax = 0` mirrors `collateralAmount = 0` —
        // the OfferCreateFacet sale-vehicle exception (BOTH zero is
        // allowed) preserves the existing behaviour where collateral
        // for the resulting loan comes from the linked live loan, not
        // from a new commitment.
        params.amountMax = loan.principal;
        params.interestRateBpsMax = interestRateBps;
        params.collateralAmountMax = 0;
        // #408 / #410 / #413 (2026-06-12), Codex PR #559 round-1
        // P2: inherit the source loan's floor-model election so the
        // replacement loan settles under the same interest model.
        // Without this, a memory-default `false` would silently
        // opt out of the full-term floor on the new lender's books
        // — re-introducing the early-repay under-charge on every
        // internal builder flow (sale vehicle here, offset in
        // PrecloseFacet).
        params.useFullTermInterest = loan.useFullTermInterest;
        // #1503 (design item 23) — the SAME rule, for the three behavioural
        // terms the line above forgot. `_buildSaleParams` assigned only
        // `useFullTermInterest`, so these took struct defaults (`false`,
        // `false`, `None`) on every sale vehicle while the live loan carried
        // its real values.
        //
        // A buyer then reviewed and signed "this position does not allow
        // partial repayment, does not allow prepay listing, and settles no
        // periodic interest", and the accept-time binding compared that against
        // the vehicle and AGREED — because the vehicle genuinely said so. The
        // position they received could permit all three. These are exactly the
        // terms that decide what the borrower may do to the buyer afterwards.
        //
        // Mirroring at LISTING time (rather than binding the live loan at
        // acceptance) is sufficient and permanently correct because all three
        // are immutable for the loan's lifetime: `LoanFacet` writes them once
        // at initiation and nothing else in `src/` ever writes them again.
        // Principal is the field that genuinely needs a live read — a partial
        // repay shrinks it — and these are not like principal.
        //
        // Keeping the vehicle TRUTHFUL also keeps every consumer correct
        // without change: the accept binding, the review screens that display
        // `offer.allowsPartialRepay`, and every other client that reads the
        // offer. Making the loan authoritative at acceptance instead would have
        // required a coordinated change across four separate terms builders and
        // left an upgrade window where old and new halves disagree.
        params.allowsPartialRepay = loan.allowsPartialRepay;
        params.allowsPrepayListing = loan.allowsPrepayListing;
        params.periodicInterestCadence = loan.periodicInterestCadence;
        // Phase 6: keeper enables are per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. The outgoing lender (sale-
        // offer creator) can enable specific keepers on this sale offer
        // via `ProfileFacet.setOfferKeeperEnabled` after creation.
    }

    /**
     * @dev Design item 1 — validates the seller-chosen listing window and
     *      returns the bounded, maturity-clamped `expiresAt`. Own frame so
     *      the maturity math doesn't deepen `createLoanSaleOffer`'s stack.
     *
     *      Rules:
     *        1. `listingSeconds` must be inside
     *           [MIN_SALE_LISTING_SECONDS, MAX_SALE_LISTING_SECONDS] — there
     *           is no never-expires option and no sub-minimum flash listing.
     *        2. The expiry is clamped at the loan's LIVE maturity
     *           (`LibLoanClock.maturity`, the pause credit included), so a listing can never be
     *           accepted inside the grace window: `isOfferExpired` treats
     *           `now >= expiresAt` as expired, and stamping exactly the
     *           maturity timestamp makes the listing die the second the loan
     *           becomes overdue.
     *        3. If clamping leaves less than the minimum window, the loan is
     *           too close to maturity to list at all — refuse, matching the
     *           Layer-1 rule that the sale rows go unavailable near maturity
     *           instead of advertising an exit that cannot complete.
     */
    function _boundListingExpiry(
        LibVaipakam.Loan storage loan,
        uint64 listingSeconds
    ) private view returns (uint64 expiresAt) {
        if (
            listingSeconds < LibVaipakam.MIN_SALE_LISTING_SECONDS ||
            listingSeconds > LibVaipakam.MAX_SALE_LISTING_SECONDS
        ) revert SaleListingWindowInvalid();
        // The verdict refused a loan with less than `MIN_SALE_LISTING_SECONDS`
        // of term left, so with a window of at least that long the clamped
        // expiry below still leaves the listing that long to run (#1841).
        uint256 maturity = LibLoanClock.maturity(loan);
        uint256 requested = block.timestamp + uint256(listingSeconds);
        expiresAt = uint64(requested < maturity ? requested : maturity);
    }

    /**
     * @notice Step 2: Completes a loan sale after the borrower-style offer has been accepted.
     * @dev Normally invoked atomically from {OfferFacet.acceptOffer} in the
     *      same transaction as acceptance — users do NOT click a separate
     *      "Complete Sale" button under the happy path. This entry point is
     *      retained as a manual recovery hook (e.g., for sales accepted
     *      before auto-completion was introduced, or keeper-driven
     *      retries). Callable by the current lender-NFT holder OR a
     *      keeper with the COMPLETE_LOAN_SALE action bit and the
     *      per-loan enable for this loan (lender-entitled action).
     *      Verifies the linked sale offer was accepted, then:
     *      - Principal: Already transferred from Noah to liam by acceptOffer() (no second transfer).
     *      - Records the seller's earned-unpaid interest as a seller claim (#1209).
     *      - Handles rate shortfall if applicable.
     *      - Updates loan.lender to Noah on the live loan.
     *      - Burns liam's lender NFT and mints one for Noah.
     *      - Cleans up the temporary loan created by acceptOffer() (burns its NFTs,
     *        releases liam's locked collateral, sets dummy claims so ClaimFacet doesn't block).
     * @param loanId The loan ID whose sale to complete.
     */
    function completeLoanSale(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        _completeLoanSaleImpl(loanId);
    }

    /// @notice #951 (Codex #959) — cross-facet completion entry consumed by
    ///         `OfferAcceptFacet._acceptOffer`'s auto-link block after a buyer
    ///         accepts the linked sale offer. Skips the outer `nonReentrant`
    ///         modifier because `acceptOffer` already holds the diamond guard (a
    ///         second `_enter()` would revert `ReentrancyGuardReentrantCall` and
    ///         break the atomic accept-then-complete entirely). Same
    ///         `address(this)`-only gate as `PrecloseFacet.completeOffsetInternal`
    ///         / `createOfferInternal`.
    function completeLoanSaleInternal(
        uint256 loanId
    ) external whenNotPaused {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        _completeLoanSaleImpl(loanId);
    }

    /// @dev Shared body for `completeLoanSale` (external, `nonReentrant`) and
    ///      `completeLoanSaleInternal` (cross-facet, no outer guard).
    function _completeLoanSaleImpl(uint256 loanId) private {
        // Tier-1 sanctions gate — funds settle to msg.sender on
        // successful sale; sanctioned recipient blocked. (On the cross-facet
        // auto-complete path `msg.sender` is the diamond — a no-op — but both
        // settlement parties are already screened upstream: the buyer at
        // `acceptOffer`, the exiting seller at `createLoanSaleOffer`.)
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // Design item 1 — the live-maturity gate for a sale fill is enforced
        // at ACCEPT time in OfferAcceptFacet (`SaleLoanPastMaturity`), before
        // any buyer value moves. It is deliberately NOT re-checked here: on
        // the atomic accept-then-complete path both run in one transaction
        // (same timestamp, so a re-check could never differ), and on the
        // manual-recovery path a re-check would permanently strand a buyer
        // whose principal already moved at acceptance (Codex #1505 r1 P1).
        uint256 saleOfferId = s.loanToSaleOfferId[loanId];
        if (saleOfferId == 0) revert SaleNotLinked();

        LibVaipakam.Offer storage saleOffer = s.offers[saleOfferId];
        if (!saleOffer.accepted) revert SaleOfferNotAccepted();

        // Phase 6: role-scoped keeper authority. Lender-entitled action, so
        // resolve against the lender NFT holder and require the
        // CompleteLoanSale bit on the holder's approved-keeper bitmask.
        if (LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE,
            loan,
            /* lenderSide */ true
        )) LibServiceCapacity.chargeKeeper(); // #1219 — one keeper action

        // #951 (redesign D2) — `createLoanSaleOffer` consolidated the lender
        // position to its current holder at listing (D1), re-anchoring both
        // `loan.lender` and `heldForLender` to `ownerOf(lenderTokenId)`. So
        // `loan.lender` is now authoritative: it is the seller, it is who
        // `acceptOffer` paid the sale principal to, and it is whose vault
        // physically holds `heldForLender`. Every operation below — the
        // held-proceeds migration, the `releaseLenderProceeds` reservation
        // release, and the shortfall settlement — keys on this single
        // identity, so there is no stored-vs-economic divergence to reconcile.
        // (Codex #959 round-2 tried `ownerOf` here, which split settlement from
        // the held-proceeds custody under the stored lender; consolidating at the
        // source is the correct fix.)
        address originalLender = loan.lender;

        // ── Find the temporary loan via O(1) lookup ─────────────────────────
        uint256 tempLoanId = s.offerIdToLoanId[saleOfferId];
        if (tempLoanId == 0)
            revert LenderResolutionFailed();
        // For a Borrower-type offer: creator=liam is borrower, acceptor=Noah is lender
        address newLender = s.loans[tempLoanId].lender;
        if (newLender == address(0))
            revert LenderResolutionFailed();

        // #393 v1-b — the seller EXITS the loan here (receives sale proceeds and
        // hands the position to the buyer), so release their standing-intent
        // live-principal cap now rather than waiting for the buyer's eventual
        // claim (the buyer might never claim, stranding the seller's cap). Keyed
        // off the ORIGINATING intent so it frees the original owner's counter +
        // deletes the marker. Gated on the cheap per-loan origin check so a
        // non-intent loan skips the cross-facet hop entirely (no wasted gas, and
        // no dependency on LenderIntentFacet being routed).
        // ...unless the buyer IS the origin owner (Codex #1818 r1 P1, applied
        // to both routes): a self-purchase leaves the origin owner holding a
        // live intent loan, and releasing would free its principal from their
        // exposure cap while the exposure is still real. Marker and counter
        // are retained in that case — see the direct route's twin for the
        // full reasoning.
        if (
            s.intentOrigin[loanId].owner != address(0) &&
            s.intentOrigin[loanId].owner != newLender
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector, loanId
                ),
                bytes4(0)
            );
        }

        // Snapshot pre-existing heldForLender before any new shortfall deposits
        uint256 priorHeldSale = s.heldForLender[loanId];

        // ── Rate shortfall ──────────────────────────────────────────────────
        // #1209 (owner decision 2026-10-28, "seller keeps a claim") — the seller
        // no longer forfeits the interest they earned and were not yet paid.
        // {LibLoan.migrateLenderPosition} below records it as a seller claim on
        // the loan, paid first from the borrower's later interest
        // ({LibInterestLedger}). So the seller's only cost here is the RATE
        // SHORTFALL — the buyer's higher rate over the remaining term, deposited
        // to the buyer's held balance — and the treasury takes nothing at sale:
        // its yield fee is taken once, on each interest slice, when paid.
        // #641 / #668 / #935 — the remaining term runs from the interest clock
        // to the pause-moved end ({LibLoanClock.interestTermEnd}).
        uint256 remainingSecs = LibLoanClock.remainingInterestSeconds(loan, block.timestamp);
        uint256 originalRemainingInterest = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 saleRemainingInterest = (loan.principal *
            saleOffer.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 saleShortfall = saleRemainingInterest > originalRemainingInterest
            ? saleRemainingInterest - originalRemainingInterest
            : 0;

        // #1659 — NET SETTLEMENT out of the escrowed proceeds (canonical spec,
        // "Smart Contract Actions": the sale flow prefers net settlement so the
        // shortfall is deducted from the incoming proceeds rather than sourced
        // from the seller's wallet). `OfferAcceptFacet` escrows the buyer's
        // principal in Diamond custody on the resting-listing accept, so the
        // fan-out below matches the direct sale (`sellLoanViaBuyOffer`).
        //
        // The wallet-funded branch further down is the manual-recovery entry
        // (`completeLoanSale` with no escrow), where the seller is the caller.
        uint256 proceeds = s.saleProceedsEscrow[loanId];
        if (proceeds > 0) {
            delete s.saleProceedsEscrow[loanId];
            // #1503 item 4 — the seller's FLOOR and held CEILING, enforced only
            // while the listing's projection still describes the fill. The
            // floor bounds `proceeds − shortfall`; the shortfall only shrinks as
            // the remaining term runs down, so ordinary time inside the listing
            // window cannot trip it — a principal movement the seller never
            // reviewed can. `completeLoanSale` stays callable past the window
            // (the seller's own deliberate act), where the stale projection is
            // not enforced.
            if (
                s.saleListingBoundsRecorded[loanId] &&
                block.timestamp <= s.saleListingBoundsExpiry[loanId]
            ) {
                uint256 sellerNet = proceeds > saleShortfall ? proceeds - saleShortfall : 0;
                uint256 floorNet = s.saleListingMinSellerNet[loanId];
                if (sellerNet < floorNet) {
                    revert SaleBelowSellerFloor(floorNet, sellerNet);
                }
                uint256 heldNow = s.heldForLender[loanId];
                uint256 heldCeiling = s.saleListingMaxHeldTransfer[loanId];
                if (heldNow > heldCeiling) {
                    revert SaleAboveHeldCeiling(heldCeiling, heldNow);
                }
            }
            // The shortfall exceeding what the buyer brought cannot net-settle;
            // fail closed with the named error.
            if (saleShortfall > proceeds) revert RateShortfallTooHigh();

            uint256 toLiam = proceeds - saleShortfall;
            if (toLiam > 0) {
                // #2440 — a voluntary sale: the seller's net is refused unless
                // it all arrived, so the floor checked above is what arrives.
                LibDelivery.pushExact(loan.principalAsset, originalLender, toLiam);
            }
            if (saleShortfall > 0) {
                // #831 — vault-lock the buyer's receive: a buyer flagged AFTER
                // committing the sale must not brick the completion and strand
                // the committed seller. The shortfall parks frozen in the
                // buyer's OWN vault behind the #821 freeze.
                LibSanctionedLock.begin(s, newLender);
                LibFacet.depositForNewLender(
                    loan.principalAsset,
                    newLender,
                    saleShortfall,
                    loanId
                );
                LibSanctionedLock.end(
                    s, newLender, loanId, loan.principalAsset, saleShortfall
                );
            }
        } else if (saleShortfall > 0) {
            // #831 — same buyer-receive vault-lock as the branch above; the
            // seller (the caller here) funds the shortfall from their wallet.
            LibSanctionedLock.begin(s, newLender);
            LibFacet.depositFromPayerForLender(
                loan.principalAsset,
                originalLender,
                newLender,
                saleShortfall,
                loanId
            );
            LibSanctionedLock.end(
                s, newLender, loanId, loan.principalAsset, saleShortfall
            );
        }

        // NOTE: Principal transfer already happened in acceptOffer().
        // For Borrower-type offers, acceptOffer() withdraws principal from
        // Noah's (lender) vault and sends it to liam (borrower=offer.creator).
        // No second transfer needed here.

        // #597 — release the old lender's held-for-lender VPFI reservation
        // BEFORE the physical migration withdraws it below (else the #565
        // chokepoint bricks the withdraw). `loan.lender` is still the old
        // lender here. No-op for a non-VPFI / never-reserved loan. Re-reserved
        // on the new lender after the position migrates (below).
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);
        // #998 S10 Class B (Codex fresh-round P2) — migrate the dedicated
        // active-held reservation off the OLD lender NOW, BEFORE the `priorHeldSale`
        // withdrawal below (the withdraw's free-balance guard subtracts
        // `encumbered[oldLender]`, so a still-locked reservation would revert the
        // sale). `loan.lender` is still the old lender here. No-op when nothing was
        // parked.
        LibEncumbrance.migrateActiveHeld(loanId, newLender);

        // Migrate only pre-existing heldForLender from old lender's vault to new lender's
        {
            if (priorHeldSale > 0) {
                _migrateHeldOnCompletion(
                    s, loan, loanId, originalLender, newLender, priorHeldSale
                );
            }
        }

        // #1123 — fail-closed movement gate before the completion-path migration
        // (same rationale as `sellLoanViaBuyOffer`). `from` = live lender holder.
        // #1123 — SALE gate (see the `sellLoanViaBuyOffer` rationale): block a
        // flagged/registered seller; register a flagged buyer (frozen receive
        // completes per #831).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ProfileFacet.enforcePositionSaleMove.selector,
                LibERC721.ownerOf(loan.lenderTokenId),
                newLender
            ),
            bytes4(0)
        );
        // Migrate live-loan lender position in one shot. (#998 S10 Class B —
        // `migrateLenderPosition` carries the dedicated active-held reservation to
        // `newLender` internally, before it re-anchors `loan.lender`.)
        LibLoan.migrateLenderPosition(loanId, newLender, originalLender);

        // #998 S10 (#1006) — the shortfall + migrated held above were parked into
        // the BUYER's (`newLender`) vault as `heldForLender`, claimed later via
        // `claimAsLender`. A flagged buyer is blocked at purchase while the oracle
        // is up; a buy-during-outage would otherwise slip through, so freeze that
        // held fail-closed keyed to the buyer. Routed through the cross-facet host
        // (Codex #1122-rework r1 P1) — the now registry-aware `mustFreezeParty` /
        // `sanctionsStatus` machinery is too heavy to inline into this
        // EIP-170-tight facet. The migration above made `ownerOf(lenderTokenId)`
        // == `newLender`, which the host resolves — the same address. No-op for a
        // clean buyer or when nothing was parked.
        if (s.heldForLender[loanId] > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.recordSanctionsFrozenClaimant.selector,
                    loanId,
                    true
                ),
                bytes4(0)
            );
        }

        // #597 — re-reserve the held-for-lender VPFI on the NEW lender, where it
        // now physically lives. `loan.lender` is now the new lender. Released to
        // the new lender at claim. Gated on VPFI.
        //
        // #998 S10 Class B (Codex fresh-round P2) — re-reserve only the
        // NON-active-held slice; the Class B active portion was already migrated to
        // the buyer in its dedicated ledger above, so re-reserving the full held
        // would double-count it (subset ⇒ no underflow).
        if (loan.principalAsset == s.vpfiToken) {
            uint256 nonActiveHeld = s.heldForLender[loanId] -
                s.heldForLenderEncumbered[loanId];
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, nonActiveHeld
            );
            // #1503 item 27 (#1817) — mirror of the direct route: the sale
            // moved VPFI through both parties' vaults (held migration off
            // the seller, held credit + settlement movements on the buyer),
            // so run the post-balance discount / staking checkpoint for
            // each. Cross-facet entry keeps the rollup body off this
            // EIP-170-tight facet. `originalLender` is the seller captured
            // before the migration; `newLender` is the buyer. The seller is
            // stamped only when their vault actually moved (Codex #1819 r3
            // P2) — the held migration is their sale-side vault movement, so
            // with none held their stamp would be an unrelated broadcast-
            // budget spend. (No buyer debit trough exists on THIS route: the
            // buyer's principal was escrowed in Diamond custody at accept,
            // so completion only credits their vault.)
            // No party stamps remain here (r6): the DEPARTED lender is
            // stamped at the held-withdrawal site, and the buyer at each
            // credit site — the rate-shortfall deposit and the held
            // migration. With neither movement (the legacy/manual-recovery
            // completion), nobody's vault moved and nothing may broadcast:
            // an exhausted push budget must not be able to revert the only
            // recovery hook (r6 P2).
        }

        // Old lender forfeits interaction rewards to treasury; new lender
        // gets a fresh entry covering the residual loan window. #1067 — routed
        // through the `transferLenderRewardEntry` self-hook so the O(1)
        // transfer body lives on InteractionRewardsFacet, off this tight
        // facet. ATOMIC with the settlement since #1503 item 12 — see
        // `_rewardHook` for why a failure here must not settle silently.
        _rewardHook(
            abi.encodeWithSelector(
                InteractionRewardsFacet.transferLenderRewardEntry.selector,
                loanId,
                newLender
            )
        );

        // ── Clean up temporary loan created by acceptOffer ──────────────────
        LibVaipakam.Loan storage tempLoan = s.loans[tempLoanId];

        // Burn both NFTs on the temporary loan
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                tempLoan.lenderTokenId
            ),
            NFTBurnFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                tempLoan.borrowerTokenId
            ),
            NFTBurnFailed.selector
        );

        // Release liam's collateral that was locked when creating the
        // borrower-style sale offer. liam locked collateral into his vault
        // via createOffer(Borrower, ...) — return it to him.
        // #569 §4.6 (2026-06-13) — defensive lien release for the sale-
        // vehicle temp loan before returning its collateral. The lender-
        // side sale vehicle posts ZERO collateral today (`_buildSaleParams`
        // forces `collateralAmount = 0`), so the temp loan's lien is
        // empty and this is a no-op. It is wired defensively so that if
        // a future change ever lets a sale vehicle carry real collateral,
        // the chokepoint guard on the withdraws below clears. No-op on
        // NFT rentals (D-1). EncumbranceLifecycleMap.md §4.6.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                tempLoanId
            ),
            bytes4(0)
        );
        if (tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            if (tempLoan.collateralAmount > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        originalLender,
                        tempLoan.collateralAsset,
                        originalLender,
                        tempLoan.collateralAmount
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC721
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    originalLender
                ),
                VaultWithdrawFailed.selector
            );
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    tempLoan.collateralQuantity,
                    originalLender
                ),
                VaultWithdrawFailed.selector
            );
        }

        // Mark temp loan as Repaid with zeroed-out claim records so
        // ClaimFacet's NothingToClaim check won't create a stuck artifact.
        // #1503 item 26 — the INTERNAL-VEHICLE transition: validated edge,
        // no metrics hook, no LoanStatusChanged. The vehicle was never
        // counted, indexed, or announced at initiation (the paired skips in
        // LoanFacet), so the ordinary transition would decrement an active
        // count it never incremented and hand indexers a status edge for a
        // loan they were never told exists.
        //
        // Routed by REGIME, not by code version, and the regime is read from
        // the vehicle's own durable mark. A vehicle accepted BEFORE item 26
        // carries no mark: its creation was announced, so its terminal must be
        // announced too or the row a consumer built from `LoanInitiated` sits
        // Active forever.
        //
        // Whether it was COUNTED is a SEPARATE question (Codex #1825 r1) and
        // must not be inferred from the same signal: a loan predating the
        // counter layer or its backfill can be announced yet absent from the
        // active set, and deciding both from active-list membership would
        // close such a vehicle silently — reintroducing the exact #1782
        // defect. So membership decides only the decrement.
        if (LibMetricsHooks.isInternalVehicle(s, tempLoanId)) {
            LibLifecycle.transitionInternalVehicle(
                tempLoan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            );
        } else {
            LibLifecycle.transitionLegacyVehicle(
                tempLoan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid,
                s.activeLoanIdsListPos[tempLoanId] != 0
            );
        }
        // Set claimed=true so neither party needs to (or can) claim.
        s.lenderClaims[tempLoanId] = LibVaipakam.ClaimInfo({
            asset: tempLoan.principalAsset,
            amount: 0,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: true
        });
        s.borrowerClaims[tempLoanId] = LibVaipakam.ClaimInfo({
            asset: tempLoan.collateralAsset,
            amount: 0,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: true
        });

        // #951 (Codex #959) — the sale offer is consumed; clear both link
        // directions so the loan is no longer marked as having a live listing.
        // The loan stays Active (the buyer is now its lender), so without this the
        // new owner could never list their freshly-acquired position (the
        // one-listing-per-loan guard in createLoanSaleOffer would reject it).
        delete s.loanToSaleOfferId[loanId];
        delete s.saleOfferToLoanId[saleOfferId];
        // #1503 item 4 — the bounds belong to THIS listing; leaving them would
        // apply them to the next one.
        LibSaleListing.clearSellerBounds(s, loanId);

        emit LoanSaleCompleted(loanId, originalLender, newLender);
    }

    /// @dev The `priorHeldSale > 0` migration leg of `_completeLoanSaleImpl`,
    ///      in its OWN frame: the host sits at the viaIR stack ceiling, and
    ///      the r6 mutation-site checkpoints tipped it over — this leg's
    ///      temporaries (the pay-asset pick, the withdraw encode, the two
    ///      stamps) now live here instead.
    ///
    ///      #597 Codex #672 P2 — the sanctions exemption around the from-side
    ///      withdrawal: the departed `originalLender` is LOSING custody, so
    ///      the Tier-1 vault gate must not brick the sale for the unflagged
    ///      seller. Address-scoped; the host is `nonReentrant`.
    ///
    ///      #1817 (Codex #1819 r6 P1) — the DEPARTED lender is checkpointed
    ///      at their post-withdraw balance, between the held debit and the
    ///      buyer-side redeposit: in a self-purchase (originalLender ==
    ///      newLender) the deposit returns the same vault to positive, and a
    ///      stamp taken only afterwards would observe positive -> positive
    ///      across a real zero. The BUYER is stamped after the credit (r6 P2
    ///      — stamps live where the vault moves, so a completion that moves
    ///      nothing stays broadcast-free).
    ///
    ///      #831 — `depositLocked` vault-locks the buyer-side receive so a
    ///      buyer flagged after committing cannot brick the completion
    ///      (T-051 — the Diamond-side transfer ticks the tracked counter).
    function _migrateHeldOnCompletion(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        address originalLender,
        address newLender,
        uint256 priorHeldSale
    ) private {
        address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
            ? loan.principalAsset
            : loan.prepayAsset;
        // #2440 — a voluntary sale: both hops are refused unless all of the
        // held amount arrived, so `heldForLender` keeps naming exactly what
        // the buyer's vault holds and nothing is drawn from the Diamond's
        // other balance.
        s.consolidationMoveFromUser = originalLender;
        LibFacet.vaultWithdrawExact(
            originalLender,
            payAsset,
            address(this),
            priorHeldSale,
            VaultWithdrawFailed.selector
        );
        s.consolidationMoveFromUser = address(0);
        LibSanctionedLock.depositLockedInFull(s, newLender, loanId, payAsset, priorHeldSale);
    }

    function _rewardHook(bytes memory data) private {
        // #1503 item 12 — ATOMIC with settlement, no longer best-effort. Every
        // sale quote discloses the seller's reward forfeiture and the buyer's
        // residual entry as a cost line, and a mandatory disclosure of a
        // best-effort effect is a promise the protocol does not keep: a
        // swallowed failure here settles the sale with the seller's entry
        // un-forfeited and no residual for the buyer, in silence. The transfer
        // body (`LibInteractionRewards.transferLenderEntry`) is pure O(1)
        // storage bookkeeping with its own early-returns for "program not
        // active" and "no entry" — on a properly-cut diamond it cannot revert,
        // so the only failure this bubbles in practice is the deploy-drift
        // case (InteractionRewardsFacet's selector unrouted), which is exactly
        // the case that must not settle silently.
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
