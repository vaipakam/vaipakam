// src/facets/OfferFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {LoanFacet} from "./LoanFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "./PrecloseFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";

/**
 * @title OfferFacet
 * @author Vaipakam Developer Team
 * @notice Creation, acceptance, and cancellation of lending and borrowing
 *         offers for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *
 *      Supports three asset forms on each leg (principal and collateral):
 *      ERC-20, ERC-721 (rental), ERC-1155 (rental, fractional quantity).
 *      NFT rentals carry a borrower prepay of `amount * durationDays` plus a
 *      `RENTAL_BUFFER_BPS` (5%) buffer; daily pro-rata deduction happens in
 *      RepayFacet, buffer is swept at resolution time.
 *
 *      Compliance surface:
 *        - Country-pair check via {LibVaipakam.canTradeBetween} using
 *          ProfileFacet-stored user countries. **Phase 1**: `canTradeBetween`
 *          always returns true — country-pair sanctions are disabled at the
 *          protocol level; the call site is retained for zero-migration
 *          re-activation in Phase 2.
 *        - Tiered KYC (README §16) — transaction value in USD is computed
 *          from the liquid leg(s) and checked against
 *          {ProfileFacet.meetsKYCRequirement} for both counterparties.
 *        - Mandatory mutual consent on every create + accept —
 *          `creatorFallbackConsent` on the offer and
 *          `acceptorFallbackConsent` at accept time. The consent covers the
 *          combined abnormal-market + illiquid-assets fallback terms
 *          (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
 *          README.md §"Liquidity & Asset Classification"). Required on
 *          every offer regardless of leg liquidity — illiquid legs would
 *          additionally fail the LTV/HF gates without it, but consent is
 *          always gathered.
 *
 *      On accept, initiates the loan via cross-facet call to
 *      {LoanFacet.initiateLoan} and auto-completes any linked lender-sale
 *      vehicle ({EarlyWithdrawalFacet.completeLoanSale}) or borrower-offset
 *      offer ({PrecloseFacet.completeOffset}) atomically.
 */
contract OfferFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    /// @notice Emitted when a new offer is created.
    /// @param offerId The unique ID of the created offer.
    /// @param creator The address of the user creating the offer.
    /// @param offerType The type of offer (Lender or Borrower).
    event OfferCreated(
        uint256 indexed offerId,
        address indexed creator,
        LibVaipakam.OfferType offerType
    );

    /// @notice Emitted when an offer is accepted.
    /// @param offerId The ID of the accepted offer.
    /// @param acceptor The address of the user accepting the offer.
    /// @param loanId The ID of the initiated loan.
    event OfferAccepted(
        uint256 indexed offerId,
        address indexed acceptor,
        uint256 loanId
    );

    /// @notice Emitted when an offer is canceled.
    /// @param offerId The ID of the canceled offer.
    /// @param creator The address of the creator canceling the offer.
    event OfferCanceled(uint256 indexed offerId, address indexed creator);

    /// @notice Emitted alongside `OfferCanceled` with the full offer terms
    ///         that would otherwise be irrecoverable after `cancelOffer`
    ///         executes the `delete s.offers[offerId]` storage wipe.
    ///
    ///         Frontends use this event to render cancelled offers in
    ///         "Your Offers" surfaces (Dashboard) without having to keep
    ///         a per-create localStorage snapshot. The legacy
    ///         `OfferCanceled` event remains emitted so historical
    ///         consumers that only care about identity (id + creator)
    ///         keep working unchanged.
    /// @param offerId        The ID of the canceled offer.
    /// @param creator        The address of the creator canceling.
    /// @param offerType      Lender (0) or Borrower (1).
    /// @param assetType      Principal asset type (ERC20=0, ERC721=1, ERC1155=2).
    /// @param lendingAsset   Principal asset address.
    /// @param amount         Principal amount (wei for ERC20, quantity for ERC1155).
    /// @param tokenId        Principal NFT id when `assetType` is ERC721/ERC1155, else 0.
    /// @param collateralAsset   Collateral asset address.
    /// @param collateralAmount  Collateral amount in its asset's units.
    /// @param interestRateBps   Interest rate in basis points.
    /// @param durationDays      Loan duration in days.
    event OfferCanceledDetails(
        uint256 indexed offerId,
        address indexed creator,
        LibVaipakam.OfferType offerType,
        LibVaipakam.AssetType assetType,
        address lendingAsset,
        uint256 amount,
        uint256 tokenId,
        address collateralAsset,
        uint256 collateralAmount,
        uint256 interestRateBps,
        uint256 durationDays,
        // ── Range Orders Phase 1 (docs/RangeOffersDesign.md) ─────────
        // Indexers reconstructing cancelled-offer state from this single
        // event need the full range tuple, not just the legacy single
        // values. `amountMax` / `interestRateBpsMax` mirror the offer's
        // upper bounds; `amountFilled` is the cumulative principal
        // consumed across matches before the cancel landed (lender-side
        // partial-fill case). All three are zero on offers created
        // before Range Orders Phase 1.
        uint256 amountMax,
        uint256 interestRateBpsMax,
        uint256 amountFilled
    );

    /// @dev Emitted by `OfferFacet.matchOffers` (and the
    ///      `acceptOffer` / `PrecloseFacet.transferObligationViaOffer` /
    ///      `RefinanceFacet.refinanceLoan` wrappers around the shared
    ///      matching core, once Range Orders Phase 1 PR3 lands). Single
    ///      source-of-truth event for the matched terms — both midpoints
    ///      are emitted so downstream alt-rule analytics can reconstruct
    ///      the chosen point in the overlap range. Range Orders only —
    ///      not emitted on the legacy single-value `acceptOffer` path
    ///      until that path is refactored to call the matching core.
    /// @param lenderOfferId       Lender-side offer.
    /// @param borrowerOfferId     Borrower-side offer (or 0 when the
    ///                            acceptor synthesised a single-point
    ///                            counterparty via legacy `acceptOffer`).
    /// @param loanId              Loan minted by this match.
    /// @param matcher             `msg.sender` of the matching call.
    ///                            Recorded on `Loan.matcher` for the
    ///                            1% LIF kickback at terminal.
    /// @param matchAmount         Concrete principal chosen from the
    ///                            overlap (midpoint per design §4.2).
    /// @param matchRateBps        Concrete rate chosen from the overlap.
    /// @param lenderRemainingPostMatch  Lender's `amountMax - amountFilled`
    ///                            after this match. Indexers use this to
    ///                            render the offer's fill-progress bar
    ///                            without re-reading storage.
    /// @param lifMatcherFee       Amount of LIF (in lending-asset units
    ///                            on the standard path; in VPFI on the
    ///                            Phase 5 discount path) that flowed to
    ///                            `matcher` at this match. Zero on
    ///                            VPFI-discount loans where the fee
    ///                            settles at terminal instead.
    /// @dev `OfferMatched` event moved to `OfferMatchFacet` along with
    ///      the matchOffers entry point (Range Orders Phase 1
    ///      OfferFacet split for EIP-170). Indexers filter by
    ///      signature, so the topic0 hash is identical and downstream
    ///      consumers don't notice the move.

    /// @dev Emitted when an offer's lifecycle terminates. Three reasons
    ///      cover every terminal state:
    ///        - `FullyFilled`: lender offer's `amountFilled == amountMax`
    ///          after a match (rare exact-fit; most large lenders hit
    ///          `Dust` first).
    ///        - `Dust`: `amountMax - amountFilled < amountMin` after a
    ///          match — the leftover can't satisfy the lender's per-
    ///          match minimum, so `matchOffers` auto-closes the offer
    ///          and refunds dust.
    ///        - `Cancelled`: explicit `cancelOffer`. Companion to the
    ///          legacy `OfferCanceled` / `OfferCanceledDetails` events;
    ///          this one carries the unified-reason discriminator so
    ///          frontend pickers can group three terminal classes
    ///          consistently.
    enum OfferCloseReason { FullyFilled, Dust, Cancelled }
    event OfferClosed(uint256 indexed offerId, OfferCloseReason reason);

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidOfferType();
    error InvalidOffer();
    error InvalidAssetType();
    error OfferAlreadyAccepted();
    // NotOfferCreator inherited from IVaipakamErrors
    error InsufficientAllowance();
    error LiquidityMismatch();
    error GetUserEscrowFailed(string reason);
    /// Findings 00025 — `params.durationDays > MAX_OFFER_DURATION_DAYS`.
    /// Surfaces `(provided, cap)` so the UI / SDK can show the gap.
    error OfferDurationExceedsCap(uint256 provided, uint256 cap);

    // ── Range Orders Phase 1 errors (docs/RangeOffersDesign.md §5.5) ─
    /// Range invariant: `amountMin > amountMax`.
    error InvalidAmountRange();
    /// Range invariant: `interestRateBpsMin > interestRateBpsMax`.
    error InvalidRateRange();
    /// Range invariant: `interestRateBpsMax > MAX_INTEREST_BPS`.
    error InterestRateAboveCeiling();
    /// Lender offer's `collateralAmount` is below the system-derived
    /// minimum needed to keep HF >= 1.5e18 at `amountMax` (worst case).
    /// Surfaces with `(provided, floor)` so the UI can show the gap.
    error MinCollateralBelowFloor(uint256 provided, uint256 floor);
    /// Borrower offer's `amountMax` exceeds the system-derived ceiling
    /// implied by the posted collateral.
    error MaxLendingAboveCeiling(uint256 provided, uint256 ceiling);
    /// Master kill-switch flag rejected the call. `whichFlag` identifies
    /// the gate (1=rangeAmount, 2=rangeRate, 3=partialFill) so frontend
    /// validation can surface a precise "feature disabled" hint.
    error FunctionDisabled(uint8 whichFlag);
    // Range Orders matching errors (AssetMismatch, AmountNoOverlap,
    // RateNoOverlap, CollateralBelowRequired, DurationMismatch,
    // MatchHFTooLow) live on `OfferMatchFacet` post-split — the
    // matchOffers + previewMatch entry points moved there to bring
    // OfferFacet under the EIP-170 24576-byte ceiling.

    /// Cancel fired before `MIN_OFFER_CANCEL_DELAY` elapsed since
    /// `Offer.createdAt` and `amountFilled == 0` (no match landed yet).
    /// Partial-filled offers can be cancelled immediately and don't
    /// raise this.
    error CancelCooldownActive();

    /**
     * @notice Creates a new lender or borrower offer.
     * @dev Deposits/locks the creator-side asset into the creator's per-user
     *      escrow via {EscrowFactoryFacet}:
     *        - Lender/ERC-20: `amount` of `lendingAsset`.
     *        - Lender/ERC-721 or ERC-1155: the NFT itself (custody-based rental).
     *        - Borrower/ERC-20 loan: collateral in its declared asset type.
     *        - Borrower/NFT rental: prepay + 5% buffer in `prepayAsset`.
     *      Re-checks liquidity on both legs via OracleFacet and latches
     *      the verdict into the offer. `creatorFallbackConsent` is mandatory
     *      on every create (docs/WebsiteReadme.md §"Offer and acceptance
     *      risk warnings" + README.md §"Liquidity & Asset Classification");
     *      missing consent reverts FallbackConsentRequired before any
     *      escrow movement. Mints a position NFT representing the offer.
     *      Reverts InvalidOfferType on zero duration, InvalidAmount on zero
     *      amount, InvalidAssetType on unknown asset enums.
     *      Emits OfferCreated. Callable by anyone when not paused.
     * @param params CreateOfferParams struct containing all offer parameters.
     * @return offerId The ID of the created offer.
     */
    function createOffer(
        LibVaipakam.CreateOfferParams calldata params
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        address escrow;
        (offerId, escrow) = _createOfferSetup(params);
        _pullCreatorAssetsClassic(params, escrow);
        _createOfferFinish(offerId, params);
    }

    /**
     * @notice Permit2 variant of {createOffer} (Phase 8b.1).
     *
     * @dev Pulls the creator's ERC-20 asset (principal for a Lender
     *      offer, collateral for a Borrower offer) via Uniswap's
     *      canonical Permit2 using an off-chain signature. Saves the
     *      separate `approve` tx the classic path would need.
     *
     *      Valid ONLY for ERC-20 offers on both legs — NFTs use
     *      `setApprovalForAll` flows that Permit2 doesn't cover, and
     *      NFT-rental prepay (ERC-20 prepayAsset) is handled via the
     *      classic path. Reverts {InvalidAssetType} on any non-ERC-20
     *      asset type on the side that would be pulled.
     *
     *      `permit.permitted.token` is bound to the signed EIP-712
     *      digest — Permit2 itself rejects any mismatch, so a silent
     *      wrong-asset transfer is impossible. `amount` MUST be ≤
     *      `permit.permitted.amount`.
     *
     * @param params    Same `CreateOfferParams` as {createOffer}.
     * @param permit    `PermitTransferFrom` struct the user signed.
     * @param signature 65-byte ECDSA signature over the EIP-712 digest.
     * @return offerId  The created offer's id.
     */
    function createOfferWithPermit(
        LibVaipakam.CreateOfferParams calldata params,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        // Permit2 only covers ERC-20 pulls. Reject NFT offers here so
        // the caller can't accidentally sign a Permit2 payload that
        // never gets honoured.
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            if (params.assetType != LibVaipakam.AssetType.ERC20) {
                revert InvalidAssetType();
            }
        } else {
            // Borrower: either ERC-20 collateral (Permit2 target) or
            // NFT rental with ERC-20 prepay. Permit2 targets the
            // pulled asset — collateral for ERC-20 loans, prepay for
            // NFT rentals. Both cases valid.
            if (
                params.assetType == LibVaipakam.AssetType.ERC20 &&
                params.collateralAssetType != LibVaipakam.AssetType.ERC20
            ) {
                revert InvalidAssetType();
            }
        }

        address escrow;
        (offerId, escrow) = _createOfferSetup(params);
        uint256 amount = _creatorPullAmount(offerId, params);
        // Resolve the asset the protocol actually expects to pull for
        // this offer shape. Permit2's signature digest binds the user
        // to a specific token, but Permit2 alone can't tell whether
        // that signed token matches what Vaipakam will record as the
        // funded leg — without this binding a permit signed for the
        // wrong ERC-20 would be honoured and the offer would be
        // recorded as funded against the unfunded protocol asset.
        address expectedAsset;
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            expectedAsset = params.lendingAsset;
        } else if (params.assetType == LibVaipakam.AssetType.ERC20) {
            // Borrower ERC-20 offer — Permit2 pulls the collateral
            // (collateral is required to be ERC-20 here, enforced in
            // the asset-type guard above).
            expectedAsset = params.collateralAsset;
        } else {
            // Borrower NFT rental offer — Permit2 pulls the prepay.
            expectedAsset = params.prepayAsset;
        }
        LibPermit2.pull(msg.sender, escrow, expectedAsset, amount, permit, signature);
        _createOfferFinish(offerId, params);
    }

    /// @dev Shared pre-pull setup. Runs every validation + allocates
    ///      the offer id + writes offer fields + stores liquidity.
    ///      Returns the new offer id and the caller's escrow address
    ///      so the caller can do the actual asset pull via whichever
    ///      path (safeTransferFrom vs Permit2) fits.
    function _createOfferSetup(
        LibVaipakam.CreateOfferParams calldata params
    ) private returns (uint256 offerId, address escrow) {
        if (params.durationDays == 0) revert InvalidOfferType();
        // Findings 00025 — ProjectDetailsREADME §2 mandates
        // 1 ≤ durationDays ≤ 365 with on-chain enforcement so external
        // callers can't bypass the frontend validation and create a
        // 1000-day loan whose interest formula over-charges (interest
        // = principal × rate × days / 365). The lower bound is the
        // previous `== 0` check (caught by `InvalidOfferType`); this
        // is the on-chain upper bound. Cap is governance-tunable via
        // `ConfigFacet.setMaxOfferDurationDays` within bounded floor
        // / ceiling — defaults to 365 on a fresh deploy.
        uint256 maxDuration = LibVaipakam.cfgMaxOfferDurationDays();
        if (params.durationDays > maxDuration) {
            revert OfferDurationExceedsCap(params.durationDays, maxDuration);
        }
        if (params.amount <= 0) revert InvalidAmount();

        // Phase 4.3 — address-level sanctions screening at the "entering
        // a new business relationship" boundary. No-op on chains where
        // governance has not configured the oracle address.
        if (LibVaipakam.isSanctionedAddress(msg.sender)) {
            revert ProfileFacet.SanctionedAddress(msg.sender);
        }

        // Self-lending guard: principal and collateral must reference
        // distinct asset contracts.
        if (
            params.lendingAsset != address(0) &&
            params.lendingAsset == params.collateralAsset
        ) revert SelfCollateralizedOffer();

        // Per-asset pause (governance-controlled reserve pause).
        LibFacet.requireAssetNotPaused(params.lendingAsset);
        LibFacet.requireAssetNotPaused(params.collateralAsset);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        unchecked {
            offerId = ++s.nextOfferId;
        }
        s.userOfferIds[msg.sender].push(offerId);

        LibVaipakam.Offer storage offer = s.offers[offerId];
        _writeOfferFields(offer, offerId, params);

        LibVaipakam.LiquidityStatus principalLiq = OracleFacet(address(this))
            .checkLiquidity(params.lendingAsset);
        LibVaipakam.LiquidityStatus collateralLiq = OracleFacet(address(this))
            .checkLiquidity(params.collateralAsset);
        offer.principalLiquidity = principalLiq;
        offer.collateralLiquidity = collateralLiq;

        if (!params.creatorFallbackConsent) revert FallbackConsentRequired();

        // ── Range Orders Phase 1 — system-derived bound enforcement ────
        // Active ONLY when the master `rangeAmountEnabled` flag is on
        // (i.e., the offer's `amountMax > amount` is permissible). When
        // Range Orders is dormant (default), every offer is effectively
        // single-value and the runtime HF gate at LoanFacet.initiateLoan
        // is sufficient — there's no worst-case-corner to defend against.
        // Apply ONLY to ERC-20-on-both-legs offers where both legs are
        // Liquid (matches the runtime HF gate's scope; NFT rentals +
        // illiquid pairs go through different gates).
        LibVaipakam.ProtocolConfig storage cfg2 =
            LibVaipakam.storageSlot().protocolCfg;
        if (
            cfg2.rangeAmountEnabled
            && params.assetType == LibVaipakam.AssetType.ERC20
            && params.collateralAssetType == LibVaipakam.AssetType.ERC20
            && principalLiq == LibVaipakam.LiquidityStatus.Liquid
            && collateralLiq == LibVaipakam.LiquidityStatus.Liquid
        ) {
            if (params.offerType == LibVaipakam.OfferType.Lender) {
                // Lender's required collateral must clear the floor at
                // the worst-case lending size (`offer.amountMax` after
                // auto-collapse).
                uint256 floor = LibRiskMath.minCollateralForLending(
                    offer.amountMax,
                    params.lendingAsset,
                    params.collateralAsset
                );
                if (floor > 0 && params.collateralAmount < floor) {
                    revert MinCollateralBelowFloor(params.collateralAmount, floor);
                }
            } else {
                // Borrower's accepted lending ceiling (their `amountMax`)
                // can't exceed the system-derived ceiling implied by the
                // collateral they're posting.
                uint256 ceiling = LibRiskMath.maxLendingForCollateral(
                    params.collateralAmount,
                    params.lendingAsset,
                    params.collateralAsset
                );
                if (ceiling != type(uint256).max && offer.amountMax > ceiling) {
                    revert MaxLendingAboveCeiling(offer.amountMax, ceiling);
                }
            }
        }

        escrow = getUserEscrow(msg.sender);
    }

    /// @dev Classic-path asset pull: the big if/else that lives in
    ///      {createOffer}. Handles every combination of offer side +
    ///      asset type. Permit2 callers skip this and invoke
    ///      `LibPermit2.pull` with the signed permit instead.
    function _pullCreatorAssetsClassic(
        LibVaipakam.CreateOfferParams calldata params,
        address escrow
    ) private {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                // Range Orders Phase 1: pre-escrow the upper bound
                // (`amountMax`) so subsequent partial fills draw from
                // the lender's already-locked custody. Auto-collapse
                // (params.amountMax == 0 → params.amount) keeps legacy
                // single-value callers byte-identical.
                uint256 lenderPull = params.amountMax == 0
                    ? params.amount
                    : params.amountMax;
                IERC20(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    lenderPull
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC721) {
                IERC721(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    params.tokenId
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC1155) {
                IERC1155(params.lendingAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    params.tokenId,
                    params.quantity,
                    ""
                );
            } else {
                revert InvalidAssetType();
            }
        } else {
            // Borrower: lock collateral (or prepay for NFT rental).
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                if (params.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    IERC20(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralAmount
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralTokenId
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(params.collateralAsset).safeTransferFrom(
                        msg.sender,
                        escrow,
                        params.collateralTokenId,
                        params.collateralQuantity,
                        ""
                    );
                } else {
                    revert InvalidAssetType();
                }
            } else if (
                params.assetType == LibVaipakam.AssetType.ERC721 ||
                params.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                uint256 totalPrepay = _nftRentalPrepayTotal(params.amount, params.durationDays);
                IERC20(params.prepayAsset).safeTransferFrom(
                    msg.sender,
                    escrow,
                    totalPrepay
                );
            } else {
                revert InvalidAssetType();
            }
        }
    }

    /// @dev Computes the ERC-20 amount the Permit2 path needs to pull
    ///      for an offer created via {createOfferWithPermit}. Mirrors
    ///      the classic path's asset selection: lender-side ERC-20
    ///      loan = principal, borrower-side ERC-20 loan = collateral,
    ///      borrower-side NFT rental = prepay+buffer.
    function _creatorPullAmount(
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private view returns (uint256) {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            // Range Orders Phase 1: pre-escrow `amountMax` so partial
            // fills draw from custody. Auto-collapse for legacy callers.
            return params.amountMax == 0 ? params.amount : params.amountMax;
        }
        if (params.assetType == LibVaipakam.AssetType.ERC20) {
            return params.collateralAmount;
        }
        // NFT rental borrower offer — Permit2 pulls the prepay.
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];
        return _nftRentalPrepayTotal(offer.amount, offer.durationDays);
    }

    /// @dev Rental prepay total = amount × days + (amount × days ×
    ///      rentalBufferBps / BASIS_POINTS). Isolated from the pull
    ///      helper so the Permit2 path can call the same formula.
    /// @dev Takes the two fields it actually needs (`amount` and
    ///      `durationDays`) instead of the full `CreateOfferParams`
    ///      struct — passing the whole struct in memory used to push
    ///      the calling helper over Yul's stack-depth ceiling once
    ///      the struct grew (16-field via `allowsPartialRepay`).
    function _nftRentalPrepayTotal(
        uint256 amount,
        uint256 durationDays
    ) private view returns (uint256) {
        uint256 prepayAmount = amount * durationDays;
        uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
            LibVaipakam.BASIS_POINTS;
        return prepayAmount + buffer;
    }

    /// @dev Shared post-pull finish. Mints the Vaipakam position NFT,
    ///      runs MetricsFacet analytics hook, emits OfferCreated.
    function _createOfferFinish(
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];

        unchecked {
            offer.positionTokenId = ++s.nextTokenId;
        }
        (bool success, ) = address(VaipakamNFTFacet(address(this))).call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                msg.sender,
                offer.positionTokenId,
                offerId,
                0,
                params.offerType == LibVaipakam.OfferType.Lender,
                LibVaipakam.LoanPositionStatus.OfferCreated
            )
        );
        if (!success) revert NFTMintFailed();

        LibMetricsHooks.onOfferCreated(offer);

        emit OfferCreated(offerId, msg.sender, params.offerType);
    }

    /**
     * @dev Writes the ~18 offer fields in two frames so `forge coverage
     *      --ir-minimum` (no optimizer) doesn't pile every calldata load
     *      onto a single stack frame in {createOffer}.
     */
    function _writeOfferFields(
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        _writeOfferPrincipalFields(offer, offerId, params);
        _writeOfferCollateralFields(offer, params);
    }

    function _writeOfferPrincipalFields(
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.id = offerId;
        offer.creator = msg.sender;
        offer.offerType = params.offerType;
        offer.lendingAsset = params.lendingAsset;
        offer.amount = params.amount;
        offer.interestRateBps = params.interestRateBps;
        offer.durationDays = params.durationDays;
        offer.assetType = params.assetType;
        offer.tokenId = params.tokenId;
        offer.quantity = params.quantity;
        offer.prepayAsset = params.prepayAsset;
        // ── Range Orders Phase 1 (docs/RangeOffersDesign.md §2.1, §15)
        // Auto-collapse: when caller leaves `amountMax == 0`, copy the
        // legacy single value into `amountMax` so the offer is treated
        // as single-value (`amountMin == amountMax`). Same for the rate
        // pair. This preserves backward compat for every existing test
        // / script that builds CreateOfferParams without the new fields.
        // Range mode (`amountMax > amount`) is gated on the master flag
        // — when off, callers must collapse client-side.
        LibVaipakam.ProtocolConfig storage cfg =
            LibVaipakam.storageSlot().protocolCfg;
        uint256 effAmountMax = params.amountMax == 0
            ? params.amount
            : params.amountMax;
        uint256 effRateMax = params.interestRateBpsMax == 0
            ? params.interestRateBps
            : params.interestRateBpsMax;
        // Range invariants: min ≤ max, max within sanity ceiling.
        if (effAmountMax < params.amount) revert InvalidAmountRange();
        if (effRateMax < params.interestRateBps) revert InvalidRateRange();
        if (effRateMax > LibVaipakam.MAX_INTEREST_BPS) {
            revert InterestRateAboveCeiling();
        }
        // Master kill-switch enforcement: if the flag is off, the only
        // permitted shape is the collapsed single-value offer.
        if (!cfg.rangeAmountEnabled && effAmountMax != params.amount) {
            revert FunctionDisabled(1);
        }
        if (!cfg.rangeRateEnabled && effRateMax != params.interestRateBps) {
            revert FunctionDisabled(2);
        }
        // `partialFillEnabled` only matters on lender offers — borrower
        // offers stay single-fill in Phase 1 regardless. Even on lender
        // side, a single-value (collapsed) amount range can never
        // partial-fill (one match exhausts), so the flag check is
        // restricted to ranged-amount lender offers.
        if (
            !cfg.partialFillEnabled
            && params.offerType == LibVaipakam.OfferType.Lender
            && effAmountMax != params.amount
        ) {
            revert FunctionDisabled(3);
        }
        offer.amountMax = effAmountMax;
        offer.interestRateBpsMax = effRateMax;
        offer.amountFilled = 0;
        offer.createdAt = uint64(block.timestamp);
    }

    function _writeOfferCollateralFields(
        LibVaipakam.Offer storage offer,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.collateralAsset = params.collateralAsset;
        offer.collateralAmount = params.collateralAmount;
        offer.creatorFallbackConsent = params.creatorFallbackConsent;
        offer.collateralAssetType = params.collateralAssetType;
        offer.collateralTokenId = params.collateralTokenId;
        offer.collateralQuantity = params.collateralQuantity;
        // Lender-controlled gate for borrower-initiated partial repay.
        // See {CreateOfferParams.allowsPartialRepay} for full semantics.
        offer.allowsPartialRepay = params.allowsPartialRepay;
        // Phase 6: keeper access is per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. Creator enables specific
        // keepers post-create via `ProfileFacet.setOfferKeeperEnabled`.
    }

    /**
     * @notice Accepts an existing offer and initiates the loan.
     * @dev Compliance gates (in order): country pair via
     *      {LibVaipakam.canTradeBetween}; liquidity re-check with mutual
     *      illiquid consent; tiered KYC via
     *      {ProfileFacet.meetsKYCRequirement} on the transaction USD value.
     *
     *      Asset flow:
     *        - ERC-20 loan: lender escrow → borrower principal transfer;
     *          borrower-side collateral (ERC-20/721/1155) locked into borrower
     *          escrow.
     *        - NFT rental (Lender-offer): borrower prepay (principal fee ×
     *          days + `RENTAL_BUFFER_BPS` buffer) pulled into borrower escrow;
     *          rental user set on lender escrow.
     *        - NFT rental (Borrower-offer): lender's NFT escrowed, rental
     *          user set.
     *      Delegates loan creation to {LoanFacet.initiateLoan} (LTV/HF gates
     *      apply there). Atomically auto-completes any linked
     *      saleOfferToLoanId / offsetOfferToLoanId flow.
     *
     *      Reverts: InvalidOffer, OfferAlreadyAccepted, CountriesNotCompatible,
     *      FallbackConsentRequired, KYCRequired,
     *      EscrowWithdrawFailed, NFTRenterUpdateFailed, LoanInitiationFailed,
     *      OfferAcceptFailed. Emits OfferAccepted.
     * @param offerId The offer ID to accept.
     * @param acceptorFallbackConsent Acceptor's mandatory consent to the
     *        combined abnormal-market + illiquid-assets fallback terms
     *        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
     *        README.md §"Liquidity & Asset Classification"). Required on
     *        every accept regardless of leg liquidity; combined with
     *        offer.creatorFallbackConsent and latched into the resulting
     *        loan via {Loan.fallbackConsentFromBoth}.
     * @return loanId The ID of the initiated loan.
     */
    function acceptOffer(
        uint256 offerId,
        bool acceptorFallbackConsent
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        return
            _acceptOffer(
                offerId,
                acceptorFallbackConsent,
                /*usePermit=*/ false,
                _emptyPermit(),
                ""
            );
    }

    /// @notice Cross-facet entry point used exclusively by
    ///         `OfferMatchFacet.matchOffers` to invoke the same
    ///         `_acceptOffer` plumbing without re-acquiring the
    ///         shared `nonReentrant` lock that the outer
    ///         `matchOffers` already holds.
    /// @dev    Gated on `msg.sender == address(this)` so EOAs cannot
    ///         call this directly through the diamond fallback —
    ///         only same-tx cross-facet calls from another diamond
    ///         facet pass. Reentrancy is the caller's
    ///         responsibility (matchOffers' outer lock covers
    ///         this whole tx). The `whenNotPaused` gate also lives
    ///         on the outer entry, not here, to avoid double-checks
    ///         on an internal hop.
    ///
    ///         Permit2 is intentionally not exposed here — the
    ///         matching path doesn't pull acceptor-side ERC-20 (the
    ///         borrower's collateral is already escrowed at offer-
    ///         create time, and the lender principal flows escrow-
    ///         internal). matchOffers always passes `usePermit=false`.
    /// @param offerId                 The borrower offer the matching
    ///                                core processes (see the docstring
    ///                                on `OfferMatchFacet.matchOffers`
    ///                                for why borrower-side, not lender).
    /// @param acceptorFallbackConsent Always passed as `true` from
    ///                                matchOffers — the lender (the
    ///                                injected counterparty) consented
    ///                                at lender-offer create time.
    /// @return loanId                 Newly initiated loan id.
    function acceptOfferInternal(
        uint256 offerId,
        bool acceptorFallbackConsent
    ) external returns (uint256 loanId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        return
            _acceptOffer(
                offerId,
                acceptorFallbackConsent,
                /*usePermit=*/ false,
                _emptyPermit(),
                ""
            );
    }

    /**
     * @notice Permit2 variant of {acceptOffer} (Phase 8b.1).
     *
     * @dev Pulls the acceptor's ERC-20 asset (collateral for an ERC-20
     *      lender offer, prepay for an NFT-rental lender offer) via
     *      Uniswap's Permit2 using an off-chain signature. Saves the
     *      separate `approve` tx the classic path would need.
     *
     *      Only applies when the acceptor side actually pulls ERC-20.
     *      Borrower-offer accepts (lender as acceptor with ERC-20
     *      principal) go through the lender's escrow-internal flow and
     *      don't need Permit2 on the acceptor side — call the classic
     *      {acceptOffer} in that case. Reverts {InvalidAssetType} when
     *      no acceptor ERC-20 pull applies.
     *
     * @param offerId                 The offer to accept.
     * @param acceptorFallbackConsent Mandatory fallback-terms consent.
     * @param permit                  Signed Permit2 `PermitTransferFrom`.
     * @param signature               65-byte ECDSA signature.
     * @return loanId                 The initiated loan's id.
     */
    function acceptOfferWithPermit(
        uint256 offerId,
        bool acceptorFallbackConsent,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        // Permit2 only covers ERC-20 acceptor pulls. Pre-validate the
        // offer shape so the caller can't sign a payload that never
        // gets honoured.
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.offerType != LibVaipakam.OfferType.Lender) {
            // Borrower-offer accept: acceptor is the lender; their
            // principal flow goes escrow-internal. No acceptor pull to
            // Permit2-ify here.
            revert InvalidAssetType();
        }
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            if (offer.collateralAssetType != LibVaipakam.AssetType.ERC20) {
                revert InvalidAssetType();
            }
        }
        // else: NFT rental — prepayAsset is ERC-20 by design, valid target.
        return
            _acceptOffer(
                offerId,
                acceptorFallbackConsent,
                /*usePermit=*/ true,
                permit,
                signature
            );
    }

    /// @dev Zero-valued `PermitTransferFrom` for the classic accept
    ///      path that doesn't use Permit2. Ignored downstream because
    ///      `_acceptOffer` branches on `usePermit` before touching it.
    function _emptyPermit()
        private
        pure
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: address(0),
                    amount: 0
                }),
                nonce: 0,
                deadline: 0
            });
    }

    /// @dev NFT-rental prepay pull. Extracted from `_acceptOffer` to
    ///      keep that function's local count under viaIR's
    ///      stack-too-deep budget after the OfferFacet split.
    ///      Called only when the lender offer's `assetType` is
    ///      ERC721 / ERC1155 (NFT rental) — borrower prepays the
    ///      full term's rental fee + buffer in `prepayAsset` (a
    ///      stablecoin) into their own escrow.
    function _pullRentalPrepay(
        LibVaipakam.Offer storage offer,
        address borrower,
        address borrowerEscrow,
        bool usePermit,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes memory signature
    ) private {
        uint256 prepayAmount = offer.amount * offer.durationDays;
        uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps())
            / LibVaipakam.BASIS_POINTS;
        uint256 totalPrepay = prepayAmount + buffer;
        if (usePermit) {
            LibPermit2.pull(
                borrower,
                borrowerEscrow,
                offer.prepayAsset,
                totalPrepay,
                permit,
                signature
            );
        } else {
            IERC20(offer.prepayAsset).safeTransferFrom(
                borrower,
                borrowerEscrow,
                totalPrepay
            );
        }
    }

    function _acceptOffer(
        uint256 offerId,
        bool acceptorFallbackConsent,
        bool usePermit,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes memory signature
    ) internal returns (uint256 loanId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.accepted) revert OfferAlreadyAccepted();

        // ── Range Orders Phase 1 — address-resolution override ────────
        // When matchOffers is in flight (matchOverride.active), msg.sender
        // is the matcher (= bot, third party). The actual COUNTERPARTY
        // to the offer being processed is matchOverride.counterparty (= the
        // borrower-offer's creator when the lender offer is being
        // processed via matchOffers). Sanctions/country/KYC checks +
        // role resolution must use the real party, not the bot. The
        // matcher (= LIF kickback recipient) is matchOverride.matcher.
        // On the legacy acceptOffer path, override.active = false; both
        // `acceptor` and `matcher` resolve to msg.sender (preserving
        // pre-Phase-1 behaviour byte-identically).
        // `acceptor` resolved here is consumed throughout the function;
        // the matcher (LIF kickback recipient) is read inline at the
        // two use sites (lender-asset LIF split + `loan.matcher`
        // recording) so we don't pay a stack slot for it. viaIR's
        // stack-too-deep budget is tight in this function.
        address acceptor = s.matchOverride.active
            ? s.matchOverride.counterparty
            : msg.sender;

        // Phase 4.3 — address-level sanctions screening on both sides
        // of the match. The acceptor's check is obvious; the creator's
        // catches the edge case where a user was clean when they
        // posted the offer but was sanctioned before anyone matched.
        // No-op on chains where governance has not configured the
        // oracle address.
        if (LibVaipakam.isSanctionedAddress(acceptor)) {
            revert ProfileFacet.SanctionedAddress(acceptor);
        }
        if (LibVaipakam.isSanctionedAddress(offer.creator)) {
            revert ProfileFacet.SanctionedAddress(offer.creator);
        }

        // Per-asset pause: block accepts if either leg has been paused
        // since the offer was created. The offer creator can still cancel
        // and reclaim escrowed assets — cancelOffer is an exit path.
        LibFacet.requireAssetNotPaused(offer.lendingAsset);
        LibFacet.requireAssetNotPaused(offer.collateralAsset);

        // Check countries compatible
        string memory creatorCountry = ProfileFacet(address(this))
            .getUserCountry(offer.creator);
        string memory acceptorCountry = ProfileFacet(address(this))
            .getUserCountry(acceptor);
        if (
            keccak256(abi.encodePacked(creatorCountry)) !=
            keccak256(abi.encodePacked(acceptorCountry))
        ) {
            if (!LibVaipakam.canTradeBetween(creatorCountry, acceptorCountry)) {
                revert CountriesNotCompatible();
            }
        }

        LibVaipakam.LiquidityStatus lendingAssetLiquidity = OracleFacet(
            address(this)
        ).checkLiquidity(offer.lendingAsset);
        // Liquidation-fallback terms consent is required from both sides on
        // every offer (liquid and illiquid). Creator consent is guaranteed
        // true by createOffer; we still check both defensively so a future
        // code path that bypasses createOffer enforcement can't land a loan
        // without mutual agreement on record.
        if (!(offer.creatorFallbackConsent && acceptorFallbackConsent)) {
            revert FallbackConsentRequired();
        }

        // Tiered KYC check based on transaction value (per README Section 16)
        uint256 valueUSD = _calculateTransactionValueUSD(offer);
        if (
            !ProfileFacet(address(this)).meetsKYCRequirement(offer.creator, valueUSD) ||
            !ProfileFacet(address(this)).meetsKYCRequirement(acceptor, valueUSD)
        ) {
            revert KYCRequired();
        }

        address lenderEscrow;
        address borrowerEscrow;
        address lender;
        address borrower;

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            lender = offer.creator;
            borrower = acceptor;
            lenderEscrow = getUserEscrow(lender);
            borrowerEscrow = getUserEscrow(borrower);
        } else {
            lender = acceptor;
            borrower = offer.creator;
            lenderEscrow = getUserEscrow(lender);
            borrowerEscrow = getUserEscrow(borrower);
        }
        uint256 vpfiDiscountDeducted;
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            // Default path: deduct the 0.1% Loan Initiation Fee from the
            // lender's escrow BEFORE the net is delivered to the borrower
            // (README §6 lines 280, 332). Borrower still owes the full
            // `offer.amount` back — the fee is paid out of the lender's
            // funded principal, not added on top of the debt.
            //
            // VPFI path (Phase 5 / §5.2b): activates when the borrower has
            // enabled the platform-level VPFI-discount consent setting
            // (s.vpfiDiscountConsent[borrower]), the lending asset is
            // liquid, AND the borrower's escrow holds ≥ the FULL 0.1%
            // LIF equivalent in VPFI. On success:
            //   - Borrower pays the FULL 0.1% LIF equivalent in VPFI from
            //     escrow into Diamond custody (via
            //     LibVPFIDiscount.tryApplyBorrowerLif). No tier discount
            //     at init — the discount is realized as a time-weighted
            //     rebate on proper settlement (see ClaimFacet and
            //     LibVPFIDiscount.settleBorrowerLifProper).
            //   - Lender delivers FULL 100% principal — no lender-side
            //     haircut.
            //   - vpfiDiscountDeducted is recorded against the loan via
            //     s.borrowerLifRebate[loanId].vpfiHeld once the loan id
            //     is known (see post-initiateLoan block below).
            // On any precondition failure tryApplyBorrowerLif returns
            // (false, 0) silently and we fall through to the normal 0.1%
            // lending-asset fee path — no rebate eligibility on that path.
            bool discountApplied;
            if (
                s.vpfiDiscountConsent[borrower] &&
                lendingAssetLiquidity == LibVaipakam.LiquidityStatus.Liquid
            ) {
                (discountApplied, vpfiDiscountDeducted) = LibVPFIDiscount
                    .tryApplyBorrowerLif(offer.lendingAsset, offer.amount, borrower);
            }

            uint256 netToBorrower;
            if (discountApplied) {
                netToBorrower = offer.amount;
            } else {
                uint256 initiationFee = (offer.amount *
                    LibVaipakam.cfgLoanInitiationFeeBps()) /
                    LibVaipakam.BASIS_POINTS;
                netToBorrower = offer.amount - initiationFee;

                if (initiationFee > 0) {
                    // Range Orders Phase 1 — 1% LIF matcher kickback.
                    // `matcher` resolves to msg.sender on the legacy
                    // acceptOffer path (same person who triggered the
                    // match). Under matchOffers, matcher is the bot
                    // recorded in the matchOverride slot. Either way:
                    // 99% to treasury, 1% to matcher. Splits inline so
                    // a single LIF flow never lands 100% in either
                    // bucket. See design §"1% match fee mechanic".
                    uint256 matcherCut =
                        LibOfferMatch.matcherShareOf(initiationFee);
                    uint256 treasuryCut = initiationFee - matcherCut;
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            lender,
                            offer.lendingAsset,
                            LibFacet.getTreasury(),
                            treasuryCut
                        ),
                        TreasuryTransferFailed.selector
                    );
                    LibFacet.recordTreasuryAccrual(
                        offer.lendingAsset,
                        treasuryCut
                    );
                    if (matcherCut > 0) {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                                lender,
                                offer.lendingAsset,
                                // Read matcher inline from storage to
                                // keep this function under viaIR's
                                // stack-too-deep budget.
                                s.matchOverride.active
                                    ? s.matchOverride.matcher
                                    : msg.sender,
                                matcherCut
                            ),
                            EscrowWithdrawFailed.selector
                        );
                    }
                }
            }

            // Transfer net principal to borrower (full amount when the VPFI
            // discount path fired; principal − fee otherwise).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    lender,
                    offer.lendingAsset,
                    borrower,
                    netToBorrower
                ),
                EscrowWithdrawFailed.selector
            );
        } else {
            if (offer.offerType == LibVaipakam.OfferType.Lender) {
                // NFT renting: borrower prepays (rate × days + buffer).
                // Extracted to a helper to keep `_acceptOffer`'s local
                // count under viaIR's stack-too-deep budget after the
                // OfferFacet split.
                _pullRentalPrepay(
                    offer,
                    borrower,
                    borrowerEscrow,
                    usePermit,
                    permit,
                    signature
                );
            } else {
                // Borrower-type NFT offer accepted by lender: escrow the lender's NFT.
                // The lender (msg.sender/acceptor) must custody the NFT in their escrow
                // for the rental duration, matching the Lender-offer model.
                if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderEscrow,
                        offer.tokenId
                    );
                } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderEscrow,
                        offer.tokenId,
                        offer.quantity,
                        ""
                    );
                }
            }

            // Set renter (borrower as user)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    lender,
                    offer.lendingAsset,
                    offer.tokenId,
                    borrower,
                    uint64(block.timestamp + offer.durationDays * 1 days)
                ),
                NFTRenterUpdateFailed.selector
            );
        }

        // Lock collateral from borrower (already in escrow for Borrower offers)
        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // ERC-20 lending: lock collateral based on collateral asset type
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    if (usePermit) {
                        LibPermit2.pull(
                            borrower,
                            borrowerEscrow,
                            offer.collateralAsset,
                            offer.collateralAmount,
                            permit,
                            signature
                        );
                    } else {
                        IERC20(offer.collateralAsset).safeTransferFrom(
                            borrower,
                            borrowerEscrow,
                            offer.collateralAmount
                        );
                    }
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerEscrow,
                        offer.collateralTokenId
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerEscrow,
                        offer.collateralTokenId,
                        offer.collateralQuantity,
                        ""
                    );
                }
            }
            // ERC721/ERC1155 lender offers: borrower prepay already transferred above
        }

        // Initiate loan. Pass the override-aware `acceptor` (resolved
        // at the top of this function) — under matchOffers msg.sender
        // is the bot/relayer, not the actual counterparty. Without
        // this, `LoanFacet._copyPartyFields` would record the bot as
        // `loan.lender` (when the offer being processed is borrower-
        // type), which is exactly the bug PR3-B's address-resolution
        // refactor was meant to close. Legacy acceptOffer path:
        // `acceptor == msg.sender`, byte-identical to pre-refactor.
        bytes memory result = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                LoanFacet.initiateLoan.selector,
                offerId,
                acceptor,
                acceptorFallbackConsent
            ),
            LoanInitiationFailed.selector
        );
        loanId = abi.decode(result, (uint256));

        // Range Orders Phase 1 — record the matcher on the loan so the
        // VPFI-path 1% LIF kickback (deferred to terminal in
        // `LibVPFIDiscount.settleBorrowerLifProper` /
        // `forfeitBorrowerLif`) knows where to route. On the legacy
        // `acceptOffer` path, `matcher` resolves to `msg.sender` (the
        // acceptor — same person who triggered the match). Under
        // `matchOffers`, `matcher` resolves via the matchOverride slot
        // to the bot/relayer that submitted the match (NOT the
        // borrower-offer's creator, which would otherwise be
        // `msg.sender` of the inner _acceptOffer call frame). Stored
        // unconditionally — lender-asset paths already paid the matcher
        // synchronously above, so this only matters for VPFI-path loans,
        // but recording on every loan keeps the read cheap and uniform.
        s.loans[loanId].matcher = s.matchOverride.active
            ? s.matchOverride.matcher
            : msg.sender;

        // Update offer
        offer.accepted = true;
        LibMetricsHooks.onOfferAccepted(offerId);

        // Phase 5: record the Diamond-held VPFI against the loan once
        // the loan id is known. The settlement helpers
        // (settleBorrowerLifProper / forfeitBorrowerLif) read this slot
        // to split the held amount between the borrower rebate and
        // treasury at resolution time.
        if (vpfiDiscountDeducted > 0) {
            LibVaipakam.storageSlot()
                .borrowerLifRebate[loanId]
                .vpfiHeld = vpfiDiscountDeducted;
        }

        // Emit the discount event (after loanId is known) via
        // VPFIDiscountFacet so indexers can subscribe to a single facet for
        // discount analytics.
        if (vpfiDiscountDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitDiscountApplied.selector,
                    loanId,
                    borrower,
                    offer.lendingAsset,
                    vpfiDiscountDeducted
                ),
                OfferAcceptFailed.selector
            );
        }

        // Auto-complete linked flows atomically so there is no gap where the
        // live loan could be repaid/defaulted between acceptance and completion.
        {
            LibVaipakam.Storage storage sCheck = LibVaipakam.storageSlot();
            // Lender-sale vehicle (created by createLoanSaleOffer)
            uint256 saleLoanId = sCheck.saleOfferToLoanId[offerId];
            if (saleLoanId != 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EarlyWithdrawalFacet.completeLoanSale.selector,
                        saleLoanId
                    ),
                    OfferAcceptFailed.selector
                );
            }
            // Borrower offset offer (created by offsetWithNewOffer)
            uint256 offsetLoanId = sCheck.offsetOfferToLoanId[offerId];
            if (offsetLoanId != 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        PrecloseFacet.completeOffset.selector,
                        offsetLoanId
                    ),
                    OfferAcceptFailed.selector
                );
            }
        }

        emit OfferAccepted(offerId, msg.sender, loanId);
    }

    /**
     * @notice Cancels an unaccepted offer and returns the locked assets.
     * @dev Creator-only (enforced via {LibAuth.requireOfferCreator}).
     *      Releases whatever was actually locked during {createOffer}:
     *      principal (Lender side) or collateral / rental prepay+buffer
     *      (Borrower side), matching the original asset type. Burns the
     *      offer position NFT and deletes the Offer record.
     *      Reverts NotOfferCreator or OfferAlreadyAccepted; emits
     *      OfferCanceled.
     * @param offerId The offer ID to cancel.
     */
    function cancelOffer(uint256 offerId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        LibAuth.requireOfferCreator(offer);
        if (offer.accepted) revert OfferAlreadyAccepted();

        // ── Range Orders Phase 1 — cancel cooldown ─────────────────
        // Active ONLY when the master `partialFillEnabled` flag is on.
        // The cooldown defends against the cancel-front-run vector on
        // the matching path (design §9.2): an attacker can't watch
        // matchOffers in mempool, race a cancelOffer in, and reclaim
        // escrowed assets before the match lands. With matching
        // dormant (default), there's no front-run vector to defend
        // against, so the cooldown stays off and existing
        // create-then-cancel test flows compile-clean. Partial-filled
        // offers (`amountFilled > 0`) bypass the cooldown
        // unconditionally because the lender has already committed
        // value through prior matches — no front-run surface left.
        if (
            LibVaipakam.storageSlot().protocolCfg.partialFillEnabled
            && offer.amountFilled == 0
            && offer.createdAt != 0
            && block.timestamp < uint256(offer.createdAt) + LibVaipakam.MIN_OFFER_CANCEL_DELAY
        ) {
            revert CancelCooldownActive();
        }

        // ── Strategic-flow NFT unlock on cancel ─────────────────────────────
        // requireOfferCreator above has bound msg.sender to offer.creator. For
        // the native-lock design the position NFT never leaves its owner; we
        // only need to clear the LibERC721 lock to restore ordinary transfer
        // rights.
        //
        // (a) Preclose Option 3 offset: release the borrower position NFT.
        uint256 lockedOffsetLoanId = s.offsetOfferToLoanId[offerId];
        if (lockedOffsetLoanId != 0) {
            LibERC721._unlock(s.loans[lockedOffsetLoanId].borrowerTokenId);
            delete s.offsetOfferToLoanId[offerId];
            delete s.loanToOffsetOfferId[lockedOffsetLoanId];
        }

        // (b) EarlyWithdrawal loan sale: release the lender position NFT.
        uint256 lockedSaleLoanId = s.saleOfferToLoanId[offerId];
        if (lockedSaleLoanId != 0) {
            LibERC721._unlock(s.loans[lockedSaleLoanId].lenderTokenId);
            delete s.saleOfferToLoanId[offerId];
            delete s.loanToSaleOfferId[lockedSaleLoanId];
        }

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // Range Orders Phase 1 — refund only the UNFILLED
                // portion. createOffer pre-escrowed `amountMax`; each
                // partial match consumed a slice via matchOffers (PR3-B
                // body, dormant until then). Cancel reclaims the
                // remainder. Legacy single-value offers satisfy
                // `amountMax == amount && amountFilled == 0`, so the
                // refund equals `amount` — byte-identical to pre-Phase-1.
                uint256 effAmountMax = offer.amountMax == 0
                    ? offer.amount
                    : offer.amountMax;
                uint256 refund = effAmountMax - offer.amountFilled;
                if (refund > 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            msg.sender,
                            offer.lendingAsset,
                            msg.sender,
                            refund
                        ),
                        EscrowWithdrawFailed.selector
                    );
                }
            } else if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC721.selector,
                        msg.sender,
                        offer.lendingAsset,
                        offer.tokenId,
                        msg.sender
                    ),
                    EscrowWithdrawFailed.selector
                );
            } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                        msg.sender,
                        offer.lendingAsset,
                        offer.tokenId,
                        offer.quantity,
                        msg.sender
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        } else {
            // Borrower: Unlock what was actually deposited during createOffer
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // ERC-20 loan: collateral was deposited based on collateralAssetType
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            msg.sender,
                            offer.collateralAsset,
                            msg.sender,
                            offer.collateralAmount
                        ),
                        EscrowWithdrawFailed.selector
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC721.selector,
                            msg.sender,
                            offer.collateralAsset,
                            offer.collateralTokenId,
                            msg.sender
                        ),
                        EscrowWithdrawFailed.selector
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                            msg.sender,
                            offer.collateralAsset,
                            offer.collateralTokenId,
                            offer.collateralQuantity,
                            msg.sender
                        ),
                        EscrowWithdrawFailed.selector
                    );
                }
            } else if (
                offer.assetType == LibVaipakam.AssetType.ERC721 ||
                offer.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                // NFT rental borrower offer: ERC-20 prepayment was deposited
                uint256 prepayAmount = offer.amount * offer.durationDays;
                uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
                    LibVaipakam.BASIS_POINTS;
                uint256 totalPrepay = prepayAmount + buffer;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        msg.sender,
                        offer.prepayAsset,
                        msg.sender,
                        totalPrepay
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        }

        // Burn position NFT (not the underlying asset tokenId)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                offer.positionTokenId
            ),
            NFTBurnFailed.selector
        );

        // Stamp the cancel marker BEFORE the delete so `offers[id]` going
        // zero isn't mistaken for "never existed" by readers. The `userOfferIds`
        // reverse index still contains the id — indexers that want to display
        // "cancelled" as a terminal state read this map.
        s.offerCancelled[offerId] = true;
        LibMetricsHooks.onOfferCancelled(offerId);

        // Emit the detail variant BEFORE the storage delete so the field
        // values are still readable. Frontend "Your Offers / Cancelled"
        // surfaces hydrate cancelled rows from this event — the
        // companion `OfferCanceled` keeps emitting for historical
        // consumers that only need identity (id + creator).
        emit OfferCanceledDetails(
            offerId,
            msg.sender,
            offer.offerType,
            offer.assetType,
            offer.lendingAsset,
            offer.amount,
            offer.tokenId,
            offer.collateralAsset,
            offer.collateralAmount,
            offer.interestRateBps,
            offer.durationDays,
            offer.amountMax,
            offer.interestRateBpsMax,
            offer.amountFilled
        );

        // Range Orders Phase 1 — preserve storage on partial-filled
        // cancel. The N existing loans spawned by prior matches still
        // reference this offer's terms via `Loan.offerId`, and the
        // position NFTs' metadata (if any future renderer pulls offer
        // details) needs them. Mark `accepted = true` so the open-book
        // queries skip it; the storage slot stays intact. Zero-fill
        // cancels (no matches) delete normally — frees the slot for
        // gas refund.
        if (offer.amountFilled > 0) {
            offer.accepted = true;
        } else {
            delete s.offers[offerId];
        }

        emit OfferCanceled(offerId, msg.sender);
        emit OfferClosed(offerId, OfferCloseReason.Cancelled);
    }

    /**
     * @notice Returns open offer IDs whose creator country is trade-compatible
     *         with `user`'s country. Paginated.
     * @dev Consults {ProfileFacet.getUserCountry} for both sides and
     *      {LibVaipakam.canTradeBetween} — the trade-pair allowance table is
     *      governance-configured via {ProfileFacet.setTradeAllowance}. Walks
     *      the `activeOfferIdsList` maintained by LibMetricsHooks (bounded by
     *      `activeOffersCount`), not the lifetime sequence, so cancelled and
     *      accepted offers are never inspected. Pagination lets callers bound
     *      the per-call work even on very large order books.
     * @param user The user whose country drives the filter.
     * @param offset Number of compatible open offers to skip.
     * @param limit  Maximum number of IDs to return.
     * @return offerIds Array of compatible, unaccepted offer IDs (length ≤ limit).
     * @return total   Number of currently open offers scanned (`activeOffersCount`).
     */
    function getCompatibleOffers(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.activeOfferIdsList;
        total = src.length;
        if (limit == 0) return (new uint256[](0), total);

        string memory userCountry = ProfileFacet(address(this)).getUserCountry(user);
        uint256[] memory buffer = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 i = 0; i < total && filled < limit; ) {
            uint256 id = src[i];
            LibVaipakam.Offer storage offer = s.offers[id];
            string memory creatorCountry = ProfileFacet(address(this))
                .getUserCountry(offer.creator);
            if (LibVaipakam.canTradeBetween(userCountry, creatorCountry)) {
                if (skipped < offset) {
                    unchecked { ++skipped; }
                } else {
                    buffer[filled] = id;
                    unchecked { ++filled; }
                }
            }
            unchecked { ++i; }
        }

        offerIds = new uint256[](filled);
        for (uint256 j; j < filled; ) {
            offerIds[j] = buffer[j];
            unchecked { ++j; }
        }
    }

    // Internal helpers

    /**
     * @notice Thin wrapper around {EscrowFactoryFacet.getOrCreateUserEscrow}
     *         used to cross the facet boundary through the diamond fallback
     *         (which sets `msg.sender == address(this)` for the onlyDiamondInternal-free
     *         factory method).
     * @dev Reverts GetUserEscrowFailed on cross-facet call failure.
     * @param user The user whose escrow to resolve (created lazily).
     * @return proxy The user's escrow proxy address.
     */
    function getUserEscrow(address user) public returns (address proxy) {
        bool success;
        bytes memory result;
        (success, result) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.getOrCreateUserEscrow.selector,
                user
            )
        );
        if (!success) revert GetUserEscrowFailed("Get User Escrow failed");
        proxy = abi.decode(result, (address));
        return (proxy);
    }

    // New Internal: Calculate transaction value in USD for KYC (liquid parts only)
    /// @dev Value = (lent amount if liquid * price) + (collateral amount if liquid * price). For NFTs, rental value = amount * durationDays if liquid (but NFTs illiquid, $0).
    ///      Scaled to 1e18 for threshold comparison.
    function _calculateTransactionValueUSD(
        LibVaipakam.Offer storage offer
    ) internal view returns (uint256 valueUSD) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Lent asset value if liquid
        LibVaipakam.LiquidityStatus lentLiquidity = OracleFacet(address(this))
            .checkLiquidity(offer.lendingAsset);
        if (lentLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                .getAssetPrice(offer.lendingAsset);
            uint8 tokenDecimals = IERC20Metadata(offer.lendingAsset).decimals();
            valueUSD += (offer.amount * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        } else if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            // For NFT rentals: Rental value = amount (fee) * durationDays, but since illiquid, $0
            valueUSD += 0;
        }

        // Collateral value if liquid.
        // For lender-sale vehicle offers (collateralAmount == 0), use the live
        // loan's actual collateral amount so KYC is not undercounted.
        uint256 effectiveCollateral = offer.collateralAmount;
        uint256 linkedLoanId = s.saleOfferToLoanId[offer.id];
        if (linkedLoanId != 0 && effectiveCollateral == 0) {
            effectiveCollateral = s.loans[linkedLoanId].collateralAmount;
        }

        LibVaipakam.LiquidityStatus collLiquidity = OracleFacet(address(this))
            .checkLiquidity(offer.collateralAsset);
        if (collLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                .getAssetPrice(offer.collateralAsset);
            uint8 tokenDecimals = IERC20Metadata(offer.collateralAsset).decimals();
            valueUSD += (effectiveCollateral * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        }
    }

    /**
     * @notice Gets details of an offer.
     * @dev View function for off-chain/test queries. Returns full Offer struct.
     * @param offerId The offer ID.
     * @return offer The Offer struct.
     */
    function getOffer(
        uint256 offerId
    ) external view returns (LibVaipakam.Offer memory offer) {
        return LibVaipakam.storageSlot().offers[offerId];
    }

    /// @notice README §13.3 alias for {getOffer}. Returns the full Offer struct.
    function getOfferDetails(
        uint256 offerId
    ) external view returns (LibVaipakam.Offer memory) {
        return LibVaipakam.storageSlot().offers[offerId];
    }
}
