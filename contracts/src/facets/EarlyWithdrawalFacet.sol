// src/facets/EarlyWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibSaleSolvency} from "../libraries/LibSaleSolvency.sol";
import {LibSaleListing} from "../libraries/LibSaleListing.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
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
import {LibEntitlement} from "../libraries/LibEntitlement.sol";

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
 *           old NFTs burned, and accrued interest forfeited to treasury.
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
    ///         the offset must be cancelled or completed first.
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
        // Tier-1 sanctions gate — creating a sale offer is a state-
        // creating action by msg.sender; sanctioned wallet blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: lender-entitled strategic flow. Authority binds to the
        // current lender-NFT owner OR a keeper with the
        // InitEarlyWithdraw action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW,
            loan,
            /* lenderSide */ true
        );
        // #819 Tier-1 sanctions on the LENDER-position holder. `requireKeeperFor`
        // authorises against the lender NFT owner, but a keeper caller leaves
        // that holder unscreened — and the eventual sale proceeds settle to the
        // seller (that holder). Screen the holder here at listing CREATION: no
        // buyer is committed yet, so an atomic revert strands no counterparty.
        // (The flagged-after-listing residual on `completeLoanSale` is the
        // deferred-proceeds liveness case tracked under #821.)
        // The exiting lender (current lender-NFT holder) is the sale offer's
        // real creator — proceeds and cancel authority bind to them, NOT to a
        // keeper caller. Capture once: used for the screen here and passed as
        // the `creator` into the internal offer-create hop below (#951).
        address seller = LibERC721.ownerOf(loan.lenderTokenId);
        LibVaipakam._assertNotSanctioned(seller);
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rental lender-sale not supported in Phase 1
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidSaleOffer();
        // #951 (Codex #959 round-2) — Phase 1 lender-sale requires ERC-20
        // collateral. The vehicle escrows no fresh collateral (it stays on the
        // live loan), so an ERC-721/ERC-1155 collateral loan would make the
        // downstream accept / complete / cancel paths try to move an NFT the
        // vehicle never held. NFT-collateral lender-sale is tracked as #974.
        if (loan.collateralAssetType != LibVaipakam.AssetType.ERC20)
            revert SaleOfferCollateralMustBeERC20();

        // #951 (Codex #959) — one live listing per loan. Without this, a second
        // `createLoanSaleOffer` for the same loan mints another sale offer,
        // overwrites `loanToSaleOfferId` and strands the first `saleOfferToLoanId`,
        // so accepting one listing completes through the other and cancelling
        // either unlinks both. The link is cleared on cancel + completion, so a
        // genuine re-list is still allowed.
        if (s.loanToSaleOfferId[loanId] != 0) revert SaleOfferAlreadyExists();
        // #1001 (S3, Codex #1070) — refuse to list the lender position for sale
        // while a Preclose Option-3 offset offer is live on this loan. The offset
        // pays the CURRENT lender at completion; letting the position change hands
        // mid-offset entangles two concurrent close-outs of the same loan. The
        // offset must be cancelled or completed first (it is short-lived).
        if (s.loanToOffsetOfferId[loanId] != 0) revert OffsetActiveOnLoan();
        // #1503 PR-E (design item 11) — fail fast rather than publish a
        // listing that could not lawfully be filled. The BINDING check is
        // the accept-time one in `OfferAcceptFacet` (the position keeps
        // moving after listing, so only the fill-time read governs); this
        // one exists so a lender is told at listing time, not after a
        // buyer's transaction reverts.
        LibSaleSolvency.assertSaleSolvent(loanId);
        // Borrower action window — a previous listing on this loan ended
        // without completing (cancel / expiry / teardown). Chaining bounded
        // listings back-to-back would recreate the indefinite borrower freeze
        // the mandatory expiry exists to remove, with the seller front-running
        // the borrower's unblocked transaction at every gap. Refuse to relist
        // until the cooldown passes, surfacing WHEN so the frontend can say it.
        {
            uint64 cooldownUntil = s.saleRelistCooldownUntil[loanId];
            if (block.timestamp < cooldownUntil)
                revert SaleRelistCooldownActive(cooldownUntil);
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

        // Calculate remaining days — revert if loan is past maturity
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 elapsedDays = elapsed / 1 days;
        if (elapsedDays >= loan.durationDays) revert InvalidSaleOffer();
        uint256 remainingDays = loan.durationDays - elapsedDays;

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
     *           (`startTime + durationDays`), so a listing can never be
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
        uint256 maturity = uint256(loan.startTime) +
            uint256(loan.durationDays) * 1 days;
        uint256 requested = block.timestamp + uint256(listingSeconds);
        uint256 bounded = requested < maturity ? requested : maturity;
        if (bounded < block.timestamp + LibVaipakam.MIN_SALE_LISTING_SECONDS)
            revert SaleListingWindowInvalid();
        expiresAt = uint64(bounded);
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
     *      - Forfeits accrued interest to treasury (or applies toward shortfall).
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
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE,
            loan,
            /* lenderSide */ true
        );

        // #951 (redesign D2) — `createLoanSaleOffer` consolidated the lender
        // position to its current holder at listing (D1), re-anchoring both
        // `loan.lender` and `heldForLender` to `ownerOf(lenderTokenId)`. So
        // `loan.lender` is now authoritative: it is the seller, it is who
        // `acceptOffer` paid the sale principal to, and it is whose vault
        // physically holds `heldForLender`. Every operation below — the
        // held-proceeds migration, the `releaseLenderProceeds` reservation
        // release, and the accrued / shortfall settlement — keys on this single
        // identity, so there is no stored-vs-economic divergence to reconcile.
        // (Codex #959 round-2 tried `ownerOf` here, which split settlement from
        // the held-proceeds custody under the stored lender; consolidating at the
        // source is the correct fix.)
        address originalLender = loan.lender;

        // #393 v1-b — the seller EXITS the loan here (receives sale proceeds and
        // hands the position to the buyer), so release their standing-intent
        // live-principal cap now rather than waiting for the buyer's eventual
        // claim (the buyer might never claim, stranding the seller's cap). Keyed
        // off the ORIGINATING intent so it frees the original owner's counter +
        // deletes the marker. Gated on the cheap per-loan origin check so a
        // non-intent loan skips the cross-facet hop entirely (no wasted gas, and
        // no dependency on LenderIntentFacet being routed).
        if (s.intentOrigin[loanId].owner != address(0)) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector, loanId
                ),
                bytes4(0)
            );
        }

        // ── Find the temporary loan via O(1) lookup ─────────────────────────
        uint256 tempLoanId = s.offerIdToLoanId[saleOfferId];
        if (tempLoanId == 0)
            revert LenderResolutionFailed();
        // For a Borrower-type offer: creator=liam is borrower, acceptor=Noah is lender
        address newLender = s.loans[tempLoanId].lender;
        if (newLender == address(0))
            revert LenderResolutionFailed();

        // Snapshot pre-existing heldForLender before any new shortfall deposits
        uint256 priorHeldSale = s.heldForLender[loanId];

        // ── Accrued interest & shortfall ────────────────────────────────────
        // "Forfeited accrued" means liam absorbs the cost — the borrower has
        // not paid this interest yet.  liam must fund every token that gets
        // routed to treasury or Noah.
        // #641 — accrued/remaining split reads the interest clock (post-partial
        // origin + remaining term), not the immutable term tuple.
        uint256 accrualStart = LibVaipakam.interestAccrualStartOf(loan);
        uint256 elapsed = block.timestamp - accrualStart;
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
        // #1503 item 28 — the FORFEITURE clock is not the accrual clock. The
        // seller forfeits accrued interest because the borrower has not paid it;
        // on a periodic loan the borrower has paid part of it, since periodic
        // auto-liquidation forwards interest to the lender WITHOUT moving the
        // accrual clock. Charging from the accrual origin bills the seller for
        // interest already in their hands.
        //
        // Narrowing the WINDOW rather than subtracting an amount — see
        // {LibEntitlement.forfeitureAccrualStart}. `elapsed` above is unchanged
        // and still measures the loan's own progress, which is what
        // `remainingSecs` needs; only the forfeiture figure uses the later start.
        uint256 forfeitFrom = LibEntitlement.forfeitureAccrualStart(loanId, accrualStart);
        uint256 forfeitSecs =
            block.timestamp > forfeitFrom ? block.timestamp - forfeitFrom : 0;
        uint256 accrued = (loan.principal * loan.interestRateBps * forfeitSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 originalRemainingInterest = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 saleRemainingInterest = (loan.principal *
            saleOffer.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);

        // #1659 — NET SETTLEMENT out of the escrowed proceeds. Canonical spec,
        // "Smart Contract Actions": *"the sale flow should prefer net settlement
        // so protocol-defined forfeitures or shortfalls can be deducted directly
        // from the incoming proceeds instead of requiring Liam to source separate
        // wallet liquidity in the same asset"*.
        //
        // `OfferAcceptFacet` escrows the buyer's principal in Diamond custody on
        // the resting-listing accept, so the fan-out below is the one the DIRECT
        // sale (`sellLoanViaBuyOffer`) has always used: the same
        // `liamCost` / `treasuryCut` algebra, the same `RateShortfallTooHigh`
        // guard, and the same Diamond-resident helpers. The two routes had
        // duplicated this algebra and diverged on who funds the forfeit; they now
        // agree.
        //
        // The T-037 shape kept below (for the manual-recovery entry) paid each
        // destination with a `transferFrom` on the seller's WALLET, which assumes
        // the payer is the caller and has approved the Diamond. That holds on the
        // direct sale and on `completeLoanSale`, where the seller calls, and fails
        // on the listing accept, where the BUYER calls — reverting
        // `ERC20InsufficientAllowance` for any seller without a standing
        // allowance, masked only because the pull is skipped when `accrued == 0`.
        uint256 proceeds = s.saleProceedsEscrow[loanId];
        if (proceeds > 0) {
            delete s.saleProceedsEscrow[loanId];
            uint256 saleShortfall = saleRemainingInterest >
                originalRemainingInterest
                ? saleRemainingInterest - originalRemainingInterest
                : 0;
            // Forfeited accrued is applied to the shortfall FIRST, with only the
            // unused excess going to treasury — the spec's own ordering.
            uint256 liamCost = accrued > saleShortfall
                ? accrued
                : saleShortfall;
            // #1503 item 4 — the seller's FLOOR. Ordinary accrual across the
            // listing window cannot trip this: the floor was derived at the
            // listing's own expiry, so the whole window sits inside it. What
            // trips it is a step the seller never reviewed — a principal
            // movement or a park disqualifying the paid-through mark, which
            // re-opens the forfeiture window earlier than the projection
            // assumed. Refusing is the point; the remedy is to relist.
            // ...but only while the seller's projection still DESCRIBES the
            // fill. The floor is derived at the listing's expiry, so it bounds
            // every fill inside the window and says nothing about one after it.
            // `completeLoanSale` is lender-side-gated and deliberately remains
            // callable past the window — the seller invoking it themselves is
            // fresh authorisation, not a race — and enforcing a stale
            // projection there would refuse the seller's own deliberate act.
            //
            // Caught by an EXISTING #1801 test rather than by a new one: the
            // targeted run of the four new cases was green, and only the full
            // suite showed `forfeitsOnlyTheUnpaidStretch` completing past the
            // window and tripping a bound that was never meant to reach it.
            if (
                s.saleListingBoundsRecorded[loanId] &&
                block.timestamp <= s.saleListingBoundsExpiry[loanId]
            ) {
                uint256 sellerNet = proceeds > liamCost ? proceeds - liamCost : 0;
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
            uint256 treasuryCut = accrued > saleShortfall
                ? accrued - saleShortfall
                : 0;
            // Same rule the direct sale applies: if liam's cost exceeds what the
            // buyer brought, net settlement cannot complete — liam would owe
            // tokens we never collected from him. Fail closed with the existing
            // named error rather than reverting deep inside a token transfer.
            if (liamCost > proceeds) revert RateShortfallTooHigh();

            uint256 toLiam = proceeds - liamCost;
            if (toLiam > 0) {
                IERC20(loan.principalAsset).safeTransfer(
                    originalLender,
                    toLiam
                );
            }
            LibFacet.transferToTreasury(loan.principalAsset, treasuryCut);
            if (saleShortfall > 0) {
                // #831 — vault-lock the buyer's (newLender) receive, exactly as
                // the pulled variant did: a buyer flagged AFTER committing the
                // sale must not brick the completion and strand the committed
                // seller. The shortfall parks frozen in the buyer's OWN vault
                // behind the #821 freeze.
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
        } else if (saleRemainingInterest > originalRemainingInterest) {
            uint256 shortfall = saleRemainingInterest -
                originalRemainingInterest;
            if (accrued >= shortfall) {
                uint256 excessAccrued = accrued - shortfall;
                LibFacet.transferFromPayerToTreasury(
                    originalLender,
                    loan.principalAsset,
                    excessAccrued
                );
                // #831 — vault-lock the buyer's (newLender) receive: a buyer
                // flagged AFTER committing the sale must not brick the completion
                // (which would strand the committed seller). The shortfall parks
                // frozen in the buyer's OWN vault behind the #821 freeze.
                LibSanctionedLock.begin(s, newLender);
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    shortfall,
                    loanId
                );
                LibSanctionedLock.end(
                    s, newLender, loanId, loan.principalAsset, shortfall
                );
            } else {
                uint256 remainingShortfall = shortfall - accrued;
                uint256 totalFromLiam = accrued + remainingShortfall;
                // #831 — same buyer-receive vault-lock as the branch above.
                LibSanctionedLock.begin(s, newLender);
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    totalFromLiam,
                    loanId
                );
                LibSanctionedLock.end(
                    s, newLender, loanId, loan.principalAsset, totalFromLiam
                );
            }
        } else {
            LibFacet.transferFromPayerToTreasury(
                originalLender,
                loan.principalAsset,
                accrued
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
                address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                    ? loan.principalAsset
                    : loan.prepayAsset;
                // #597 Codex #672 P2 — same sanctions exemption as
                // `sellLoanViaBuyOffer`: the departed `originalLender` is losing
                // custody of their held VPFI, so the Tier-1 vault gate must not
                // brick the sale for the unflagged seller. Address-scoped; the
                // host is `nonReentrant`; cleared immediately after.
                s.consolidationMoveFromUser = originalLender;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        originalLender,
                        payAsset,
                        address(this),
                        priorHeldSale
                    ),
                    VaultWithdrawFailed.selector
                );
                s.consolidationMoveFromUser = address(0);
                // #831 — vault-lock the held migration into the buyer's
                // (newLender) vault: a buyer flagged after committing must not
                // brick the completion. `depositLocked` resolves the buyer vault
                // under the receive-side exemption, pushes the held from Diamond
                // custody, and emits `SanctionedProceedsLocked` when flagged
                // (T-051 — the Diamond-side transfer ticks the tracked counter).
                LibSanctionedLock.depositLocked(
                    s, newLender, loanId, payAsset, priorHeldSale
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
        LibLoan.migrateLenderPosition(loanId, newLender);

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
        }

        // Old lender forfeits interaction rewards to treasury; new lender
        // gets a fresh entry covering the residual loan window. #1067 — routed
        // best-effort through the `transferLenderRewardEntry` self-hook so the
        // O(1) transfer body lives on InteractionRewardsFacet, off this tight
        // facet (see the loan-keyed twin above for the subordinacy rationale).
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
        LibLifecycle.transition(
            tempLoan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );
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

    /// @dev #1067 — best-effort reward transfer self-call. The O(1) transfer
    ///      body lives on {InteractionRewardsFacet}; a failed low-level call is
    ///      intentionally not bubbled (the sale settlement proceeds regardless —
    ///      reward bookkeeping is subordinate). Production always cuts
    ///      InteractionRewardsFacet; a focused test harness that omits it simply
    ///      skips the reward transfer.
    function _rewardHook(bytes memory data) private {
        (bool ok, ) = address(this).call(data);
        if (!ok) {
            // best-effort — the sale settlement proceeds regardless.
        }
    }

}
