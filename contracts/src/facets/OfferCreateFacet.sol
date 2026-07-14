// src/facets/OfferCreateFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IRateModel} from "../interfaces/IRateModel.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibOfferBounds} from "../libraries/LibOfferBounds.sol";
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
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {LibUserVault} from "../libraries/LibUserVault.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";

/**
 * @title OfferCreateFacet
 * @author Vaipakam Developer Team
 * @notice Creation of lending and borrowing offers for the Vaipakam P2P
 *         lending platform. The acceptance half lives in
 *         `OfferAcceptFacet` — `OfferFacet` was split in two (Issue #67)
 *         for EIP-170 contract-size headroom.
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
 *          `creatorRiskAndTermsConsent` on the offer and
 *          `acceptorRiskAndTermsConsent` at accept time. The consent covers the
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
contract OfferCreateFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;
    using Strings for uint256;

    /// @notice Emitted when a new offer is created.
    /// @param offerId The unique ID of the created offer.
    /// @param creator The address of the user creating the offer.
    /// @param offerType The type of offer (Lender or Borrower).
    /// @custom:event-category state-change/offer-mutation
    event OfferCreated(
        uint256 indexed offerId,
        address indexed creator,
        LibVaipakam.OfferType offerType
    );

    /// @notice Companion-event payload struct for {OfferCreatedDetails}.
    /// @dev    Wrapped as a single tuple to dodge the viaIR
    ///         stack-too-deep that triggers when ~17 inline event args
    ///         expand at the emit site. ABI consumers see this as a
    ///         flat tuple after the three indexed topics.
    struct OfferCreatedFields {
        LibVaipakam.OfferType offerType;
        LibVaipakam.AssetType assetType;
        LibVaipakam.AssetType collateralAssetType;
        uint256 amount;
        uint256 tokenId;
        address collateralAsset;
        uint256 collateralAmount;
        uint256 interestRateBps;
        uint256 durationDays;
        uint256 amountMax;
        uint256 interestRateBpsMax;
        // Issue #164 — borrower-side collateral upper bound, post
        // auto-collapse. Equals `collateralAmount` on lender offers
        // and on single-value borrower offers; > collateralAmount only
        // on ranged borrower offers. Carrying it on the companion event
        // means indexer / frontend cache merges can render the
        // borrower-side range without a follow-up `getOffer` read.
        uint256 collateralAmountMax;
        bool creatorRiskAndTermsConsent;
        bool allowsPartialRepay;
        LibVaipakam.PeriodicInterestCadence periodicInterestCadence;
        // ── #195 — GTT / offer-expiry ───────────────────────────────────
        // Absolute unix-seconds deadline. `0` = GTC (no expiry). Carrying
        // it on the companion event means indexer + frontend cache merges
        // can render the offer's GTT decoration ("expires in 3h 12m";
        // "expired — anyone can clean up") directly from the OfferCreated
        // payload, no follow-up `getOffer` view-call.
        uint64 expiresAt;
        // ── #125 — DEX-style fill-mode flavour ──────────────────────────
        // `Partial` (0) = today's Range-Orders Phase-1 behaviour (the
        // backward-compat default for every legacy offer). `Aon` = the
        // offer admits exactly one full-size fill (the create-time
        // invariant `amount == amountMax` keeps the AON-required size
        // unambiguous). `Ioc` = partial-fill within `expiresAt`, then
        // the unmatched remainder lapses via the shared GTT lazy-
        // expiry path. Carrying this on the companion event lets
        // indexers + frontend cache merges render the offer's mode
        // chip ("AON" / "IOC, 60s window left") directly from the
        // event payload — no follow-up `getOffer` view-call needed.
        LibVaipakam.FillMode fillMode;
        // ── T-086 step 4 — lender consent to allow a borrower
        //    Seaport prepay collateral listing on the loan's collateral
        //    NFT. Carried on the companion event so indexer + frontend
        //    cache merges can render the offer's prepay-listing-allowed
        //    decoration directly from the OfferCreated payload — no
        //    follow-up `getOffer` view-call. See
        //    {CreateOfferParams.allowsPrepayListing}.
        bool allowsPrepayListing;
        // ── T-092 Phase 2b (#506) — refinance target. Carried on the
        //    companion event so indexers can tell a refinance-tagged
        //    Borrower offer from a standard one without a follow-up
        //    `getOffer` read (Codex round-1 P2).
        uint256 refinanceTargetLoanId;
    }

    /// @notice Companion to {OfferCreated} — full self-sufficient
    ///         payload of the new offer. Mirrors the precedent of
    ///         {OfferCancelFacet.OfferCanceledDetails}: the bare
    ///         {OfferCreated} keeps its narrow shape for legacy
    ///         filter consumers, and this companion carries the rest
    ///         so cache-merge consumers (frontend IndexedDB, watcher
    ///         D1, subgraph) can build the row entirely from the event
    ///         payload — no follow-up `getOffer` view-call needed.
    /// @dev    EventSourcingAudit §3.1 — `createdAt` is DROPPED per
    ///         §1.4 (block.timestamp lives in the log envelope).
    ///         Indexed `lendingAsset` adds a per-asset filter for
    ///         analytical indexers without forcing them to subscribe
    ///         to every offer creation event.
    /// @param offerId             Indexed primary key.
    /// @param creator             Indexed offer creator.
    /// @param lendingAsset        Indexed loan principal asset.
    /// @param fields              See {OfferCreatedFields} for field
    ///        semantics.
    /// @custom:event-category state-change/offer-mutation
    event OfferCreatedDetails(
        uint256 indexed offerId,
        address indexed creator,
        address indexed lendingAsset,
        OfferCreatedFields fields
    );

    /// @dev `OfferAccepted` is emitted by `OfferAcceptFacet` post-split
    ///      (Issue #67). Indexers filter by signature, so the topic0
    ///      hash is unchanged.

    /// @dev `OfferCanceled` and `OfferCanceledDetails` moved to
    ///      `OfferCancelFacet` along with `cancelOffer` (Range Orders
    ///      Phase 1 OfferFacet split for EIP-170). Topic0 hashes are
    ///      identical so indexers see the same event regardless of
    ///      which facet emits.

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

    /// @dev `OfferCloseReason` enum + `OfferClosed` event moved to
    ///      `OfferMatchFacet` and `OfferCancelFacet` (re-declared on
    ///      both with identical signature, so topic0 lands the same).
    ///      OfferFacet itself no longer emits `OfferClosed` — every
    ///      lifecycle terminal lives on the carved-out facets now.

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidOfferType();
    error InvalidAssetType();
    // #569 D-2 error `VpfiNotAllowedAsRentalPrepay` moved to
    // `IVaipakamErrors` (shared) so `OfferAcceptFacet` can also enforce
    // the accept-time check (Codex #572 P1 #4).
    /// @notice T-086 Round-8 (#358) §19.5 — raised when a lender offer
    ///         is created with `allowsParallelSale = true` (the
    ///         parallel-sale flow is a borrower-side option only — the
    ///         borrower lists THEIR collateral NFT for sale; a lender
    ///         has no collateral to list).
    error ParallelSaleRequiresBorrowerOffer();
    /// @notice T-086 Round-8 (#358) §19.5 — raised when a borrower
    ///         offer with ERC20 collateral is created with
    ///         `allowsParallelSale = true`. Parallel sale needs an NFT
    ///         to list on Seaport; ERC20 collateral is structurally
    ///         incompatible.
    error ParallelSaleRequiresNFTCollateral();
    /// @notice T-086 Round-8 (#358) Codex round-8 P2 #4 — raised
    ///         when `allowsParallelSale = true` is set on an offer
    ///         whose `fillMode != Aon`. Partial / IOC fills create
    ///         multiple loans against a single offer's collateral,
    ///         incompatible with parallel-sale's single-loan split-
    ///         on-fill assumption. Borrower must use Aon mode.
    error ParallelSaleRequiresAonFillMode();
    // NotOfferCreator inherited from IVaipakamErrors
    error InsufficientAllowance();
    error LiquidityMismatch();
    /// @notice T-092 Phase 2b (#506) — `refinanceTargetLoanId != 0`
    ///         on a non-Borrower offer. The refinance-target flag is
    ///         only meaningful for borrower-side offers; lender or
    ///         other offer types with the field set are a creator
    ///         mistake (likely re-using a struct without zeroing the
    ///         field). The validator in `LibAutoRefinanceCheck`
    ///         covers the Borrower-side semantic checks.
    error InvalidRefinanceTarget();
    /// Findings 00025 — `params.durationDays > MAX_OFFER_DURATION_DAYS`.
    /// Surfaces `(provided, cap)` so the UI / SDK can show the gap.
    error OfferDurationExceedsCap(uint256 provided, uint256 cap);

    // ── #195 — GTT / offer-expiry validation errors ─────────────────────
    /// `params.expiresAt != 0 && params.expiresAt <= block.timestamp`.
    /// The creator asked for an expiry that's already in the past (or
    /// exactly now); the resulting offer would be unmatchable at
    /// landing, so fail loud at create rather than create-and-strand.
    error OfferExpiryInPast();
    /// `params.expiresAt > block.timestamp + MAX_OFFER_EXPIRY_HORIZON`.
    /// Surfaces `(provided, cap)` so the UI can render the gap. The
    /// horizon caps the grief window for the permissionless-clear path
    /// (otherwise an attacker could lock a slot for decades and the
    /// permissionless-clear is unreachable until then).
    error OfferExpiryAboveCap(uint64 provided, uint256 cap);

    // ── #125 — Fill-mode validation errors ──────────────────────────────
    /// `params.fillMode == Aon && params.amount != params.amountMax`.
    /// An all-or-nothing offer with a non-trivial amount range is
    /// structurally meaningless — only the full fill is ever reachable.
    /// Forcing single-value at create lets the match-time AON gate be a
    /// simple equality check without threading the AON-required-amount
    /// through the matcher midpoint logic.
    error AonRequiresSingleValueAmount();
    /// `params.fillMode == Ioc && params.expiresAt == 0`. IOC's defining
    /// knob is the time window; an IOC without an `expiresAt` is just a
    /// Partial offer with extra metadata. Reject loud rather than let
    /// the creator post an unreachable IOC configuration.
    error IocRequiresExpiry();

    // ── Range Orders Phase 1 errors (docs/RangeOffersDesign.md §5.5) ─
    /// Range invariant: `amountMin > amountMax`.
    error InvalidAmountRange();
    /// Range invariant: `interestRateBpsMin > interestRateBpsMax`.
    error InvalidRateRange();
    /// Range invariant: `interestRateBpsMax > MAX_INTEREST_BPS`.
    error InterestRateAboveCeiling();
    /// Issue #164 — borrower-side collateral range invariant:
    /// `collateralAmount > collateralAmountMax`.
    error InvalidCollateralAmountRange();
    /// Issue #164 — lender offers must stay single-value on collateral:
    /// `collateralAmountMax != 0 && collateralAmountMax != collateralAmount`
    /// on a Lender offer. The lender's `collateralAmount` already
    /// expresses their derived requirement; a max wouldn't add meaning.
    error LenderCollateralRangeNotAllowed();
    // ── Canonical Limit-Order Phase 2 errors (#183) — strict
    //    non-zero invariants replacing the dropped auto-collapse.
    /// `params.amount == 0`. Every offer must have a positive minimum.
    error AmountMustBePositive();
    /// `params.amountMax == 0`. Under Phase 2 the canonical mapping
    /// always carries an explicit max (lender's `lendingAmount`,
    /// borrower's derived ceiling). The Phase 1 auto-collapse fallback
    /// is gone — callers shipping 0 here get fail-loud.
    error AmountMaxMustBePositive();
    /// `params.collateralAmountMax == 0`. Strict requirement on the
    /// collateral upper bound.
    error CollateralAmountMaxMustBePositive();
    /// `params.collateralAmount == 0`. Strict requirement on the
    /// collateral lower bound — both lender (single-value required
    /// collateral) and borrower (derived floor commit) need a
    /// positive value.
    error CollateralMustBePositive();
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

    // `CancelCooldownActive` moved to `OfferCancelFacet` along with
    // `cancelOffer` (Range Orders Phase 1 OfferFacet split for
    // EIP-170).

    /**
     * @notice Creates a new lender or borrower offer.
     * @dev Deposits/locks the creator-side asset into the creator's per-user
     *      vault via {VaultFactoryFacet}:
     *        - Lender/ERC-20: `amount` of `lendingAsset`.
     *        - Lender/ERC-721 or ERC-1155: the NFT itself (custody-based rental).
     *        - Borrower/ERC-20 loan: collateral in its declared asset type.
     *        - Borrower/NFT rental: prepay + 5% buffer in `prepayAsset`.
     *      Re-checks liquidity on both legs via OracleFacet and latches
     *      the verdict into the offer. `creatorRiskAndTermsConsent` is mandatory
     *      on every create (docs/WebsiteReadme.md §"Offer and acceptance
     *      risk warnings" + README.md §"Liquidity & Asset Classification");
     *      missing consent reverts RiskAndTermsConsentRequired before any
     *      vault movement. Mints a position NFT representing the offer.
     *      Reverts InvalidOfferType on zero duration, InvalidAmount on zero
     *      amount, InvalidAssetType on unknown asset enums.
     *      Emits OfferCreated. Callable by anyone when not paused.
     * @param params CreateOfferParams struct containing all offer parameters.
     * @return offerId The ID of the created offer.
     */
    function createOffer(
        LibVaipakam.CreateOfferParams calldata params
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        address vault;
        (offerId, vault) = _createOfferSetup(msg.sender, params);
        _pullCreatorAssetsClassic(offerId, msg.sender, params, vault);
        _createOfferFinish(msg.sender, offerId, params);
    }

    /// @notice Cross-facet entry used exclusively by
    ///         `PrecloseFacet.offsetWithNewOffer` (Option 3 offset
    ///         flow) to mint a new lender offer mid-flight. Skips the
    ///         outer `nonReentrant` modifier because the calling facet
    ///         already holds the diamond's reentrancy guard — without
    ///         the bypass, the second `_enter()` reverts and the
    ///         entire offset path is unusable.
    /// @dev    Gated on `msg.sender == address(this)` so EOAs cannot
    ///         call it directly through the diamond fallback. Same
    ///         pattern as `acceptOfferInternal`. Pausable still
    ///         applies — `whenNotPaused` runs.
    ///
    ///         The `creator` parameter is the on-behalf-of address.
    ///         Inside a diamond, `address(this).call(...)` makes
    ///         `msg.sender == diamond` for the inner code, which
    ///         would corrupt `offer.creator` and the asset-pull
    ///         allowance check. The caller passes the real user
    ///         (e.g. alice for offsetWithNewOffer) so every helper
    ///         operates on her behalf instead of the Diamond's.
    function createOfferInternal(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        address vault;
        (offerId, vault) = _createOfferSetup(creator, params);
        _pullCreatorAssetsClassic(offerId, creator, params, vault);
        _createOfferFinish(creator, offerId, params);
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

        address vault;
        (offerId, vault) = _createOfferSetup(msg.sender, params);
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
        // #576 — a CARRY-OVER refinance offer pledges NO fresh collateral, so
        // skip the Permit2 pull + deposit-record entirely (mirrors the
        // classic-path skip in `_pullCreatorAssetsClassic`); RefinanceFacet
        // retags the old lien. Without this, a Permit2 refinance would force a
        // second collateral batch and lose the carry-over.
        if (LibVaipakam.storageSlot().offers[offerId].refinanceCarryOver) {
            _createOfferFinish(msg.sender, offerId, params);
            return offerId;
        }
        LibPermit2.pull(msg.sender, vault, expectedAsset, amount, permit, signature);
        // Permit2 already moved funds to the user's vault. Record
        // the deposit in the protocolTrackedVaultBalance counter so
        // it stays the symmetric mirror of the classic-path
        // `vaultDepositERC20` flow above. Every Permit2-funded leg
        // here is ERC-20 (the asset-type guards at the top of the
        // function reject any other shape), so the counter is the
        // right home for it.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.recordVaultDepositERC20.selector,
                msg.sender,
                expectedAsset,
                amount
            ),
            VaultDepositFailed.selector
        );
        _createOfferFinish(msg.sender, offerId, params);
    }

    /// @notice #400 — resolve the active quote-time {IRateModel} for a given
    ///         input. Returns `input.referenceRateBps` verbatim when no model
    ///         is registered (the IDENTITY default), else the model's quote.
    /// @dev    PURE READ — this never mutates an offer and is never called by
    ///         the manual create path (a human's typed rate is binding). It is
    ///         the single resolver the dApp calls for rate *guidance* and the
    ///         automated/delegated-pricing flows (#393 auto-lend / auto-roll /
    ///         keeper-posted intents, #394 risk premiums) call to price the
    ///         offers they create on a user's behalf — they then pass the
    ///         result as that offer's rate via the normal create path. Keeping
    ///         pricing in the *caller* (not forced on every offer) is what
    ///         preserves the human order book's market-driven price discovery.
    ///         The returned value is still subject to the usual
    ///         range-ordering + `MAX_INTEREST_BPS` checks when an offer is
    ///         actually created with it.
    function quoteOfferRateBps(
        IRateModel.RateModelInput calldata input
    ) external view returns (uint256 rateBps) {
        address rateModel = LibVaipakam.cfgRateModel();
        if (rateModel == address(0)) return input.referenceRateBps; // identity

        uint256 quoted = IRateModel(rateModel).quoteRateBps(input);

        // #400 (hardening) — CLAMP the model to within ±maxDeviation of the
        // reference (market) rate. This is the anti-rate-setting guarantee: a
        // registered model — even a buggy or adversarial one — can only nudge
        // the rate around the market anchor the caller supplies, never drive an
        // automated offer far off-market (instant-loss-fill if too low,
        // idle-capital if too high). Enforced HERE in the substrate so every
        // consumer inherits it, not trusted to each caller.
        uint256 ref = input.referenceRateBps;
        uint256 dev = LibVaipakam.cfgRateModelMaxDeviationBps();
        uint256 lo = ref > dev ? ref - dev : 0;
        uint256 hi = ref + dev;
        if (quoted < lo) quoted = lo;
        else if (quoted > hi) quoted = hi;
        // The usual protocol ceiling still binds when an offer is created with
        // this rate; mirror it here so a guidance read never returns above it.
        if (quoted > LibVaipakam.MAX_INTEREST_BPS) quoted = LibVaipakam.MAX_INTEREST_BPS;
        return quoted;
    }

    /// @notice Funding mode for a materialized signed offer (#396 v0.5).
    ///         `VaultBacked` (0): the signer pre-funded their vault, so the
    ///         creator-side stake is already free vault balance — skip the
    ///         wallet pull, assert the free balance covers the stake, and let
    ///         `_createOfferFinish`'s offer-principal lien lock it.
    ///         `WalletWitness` (1): pull the stake from the signer's wallet via
    ///         Permit2 `permitWitnessTransferFrom`, the offer hash bound as the
    ///         witness so one signature authorizes the pull AND the terms.
    enum SignedFunding {
        VaultBacked,
        WalletWitness
    }

    /// @notice The signed offer's shape isn't supported in v0.5 (only ERC-20
    ///         Lender-principal and ERC-20-collateral Borrower offers; NFT
    ///         lender / NFT-rental / refinance-tagged are out of v0.5 scope).
    error SignedOfferUnsupportedShape();
    /// @notice Vault-backed signed offer: the signer's free vault balance of
    ///         the staked asset is below the offer stake.
    error SignedOfferInsufficientFreeBalance(
        address asset,
        uint256 free,
        uint256 needed
    );

    /// @notice Materialize a signed off-chain offer into a normal on-chain
    ///         offer at the instant of fill (#396 v0.5). Self-gated cross-facet
    ///         entry called ONLY by `OfferAcceptFacet`'s signed-offer accept
    ///         path, which has already verified the signature + nonce/replay
    ///         ledger. Reuses `_createOfferSetup` + `_createOfferFinish`
    ///         verbatim (all validation + the NFT mint + the offer-principal
    ///         lien) and swaps only the asset pull by `fundingMode`.
    /// @dev    Gated on `msg.sender == address(this)` (diamond) like
    ///         `createOfferInternal`. `creator` is the real signer (passed
    ///         on-behalf-of so `offer.creator` + the lien + sanctions all
    ///         resolve to the signer, not the diamond). v0.5 restricts the
    ///         shape to the two clean ERC-20 legs the Permit2 / free-balance
    ///         funding can serve; NFT and refinance-tagged offers revert
    ///         `SignedOfferUnsupportedShape`.
    /// @notice Vault-backed materialize entry (narrow ABI boundary — the
    ///         caller encodes only `(creator, params)`, keeping the
    ///         cross-facet call site under viaIR's stack ceiling). The
    ///         signer's stake is already free vault balance.
    /// @param creator The offer signer (on-behalf-of). @param params Terms.
    /// @return offerId The materialized on-chain offer id.
    function createSignedOfferVault(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        ISignatureTransfer.PermitTransferFrom memory emptyPermit;
        return _materializeSignedOffer(
            creator, params, SignedFunding.VaultBacked, emptyPermit, bytes32(0), ""
        );
    }

    /// @notice Wallet-backed (Permit2-witness) materialize entry.
    /// @param creator   The offer signer (on-behalf-of). @param params Terms.
    /// @param permit    Permit2 struct the signer signed.
    /// @param witness   The SignedOffer hash bound as the Permit2 witness.
    /// @param permitSig The Permit2 witness signature.
    /// @return offerId  The materialized on-chain offer id.
    function createSignedOfferWallet(
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes32 witness,
        bytes calldata permitSig
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        return _materializeSignedOffer(
            creator, params, SignedFunding.WalletWitness, permit, witness, permitSig
        );
    }

    /// @dev Shared materialize body for both signed-offer funding entries.
    ///      Reuses `_createOfferSetup` + `_createOfferFinish` verbatim and
    ///      swaps only the asset pull by `fundingMode`. `creator` is the real
    ///      signer (passed on-behalf-of so `offer.creator` + the lien +
    ///      sanctions resolve to the signer, not the diamond). v0.5 restricts
    ///      the shape to the two clean ERC-20 legs.
    function _materializeSignedOffer(
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        SignedFunding fundingMode,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes32 witness,
        bytes memory permitSig
    ) private returns (uint256 offerId) {
        // v0.5 supported shapes: ERC-20 Lender-principal offer, or
        // ERC-20-collateral Borrower offer. NFT lender / NFT-rental
        // (prepay) / refinance-tagged are deferred.
        address fundedAsset = _resolveSignedOfferStakeAsset(params);
        if (params.refinanceTargetLoanId != 0) {
            revert SignedOfferUnsupportedShape();
        }

        address vault;
        (offerId, vault) = _createOfferSetup(creator, params);
        uint256 amount = _creatorPullAmount(offerId, params);

        if (fundingMode == SignedFunding.VaultBacked) {
            // Funds already sit in the signer's vault as free balance — assert
            // they cover the stake, then SKIP the wallet pull. The
            // `_createOfferFinish` offer-principal lien locks the verified free
            // balance; the immediate accept (caller side) consumes + releases
            // it. No `recordVaultDepositERC20` — the balance was tracked when
            // the signer originally deposited it.
            uint256 raw = LibVaipakam.storageSlot()
                .protocolTrackedVaultBalance[creator][fundedAsset];
            uint256 free = LibEncumbrance.freeBalance(creator, fundedAsset, 0, raw);
            if (free < amount) {
                revert SignedOfferInsufficientFreeBalance(fundedAsset, free, amount);
            }
        } else {
            // Wallet-witness: one Permit2 signature binds the pull + the terms.
            LibPermit2.pullWithWitness(
                creator,
                vault,
                fundedAsset,
                amount,
                permit,
                witness,
                LibSignedOffer.WITNESS_TYPE_STRING,
                permitSig
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.recordVaultDepositERC20.selector,
                    creator,
                    fundedAsset,
                    amount
                ),
                VaultDepositFailed.selector
            );
        }
        _createOfferFinish(creator, offerId, params);
    }

    /// @dev Resolve the creator-side staked ERC-20 asset for a signed offer
    ///      and enforce the v0.5 supported shape. Lender ⇒ `lendingAsset`
    ///      (principal); ERC-20 Borrower ⇒ `collateralAsset`. Any non-ERC-20
    ///      leg reverts `SignedOfferUnsupportedShape` (NFT lender + NFT-rental
    ///      prepay funding are deferred past v0.5).
    function _resolveSignedOfferStakeAsset(
        LibVaipakam.CreateOfferParams calldata params
    ) private pure returns (address) {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            // BOTH legs must be ERC-20 in v0.5: the principal (the lender's
            // stake, checked) AND the collateral the borrower will pledge. A
            // signed lender offer requiring ERC-721/1155 collateral would
            // otherwise materialize and route through the untested NFT-
            // collateral accept path (out of v0.5 scope).
            if (
                params.assetType != LibVaipakam.AssetType.ERC20 ||
                params.collateralAssetType != LibVaipakam.AssetType.ERC20
            ) {
                revert SignedOfferUnsupportedShape();
            }
            return params.lendingAsset;
        }
        if (
            params.assetType != LibVaipakam.AssetType.ERC20 ||
            params.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) {
            revert SignedOfferUnsupportedShape();
        }
        return params.collateralAsset;
    }

    /// @dev Shared pre-pull setup. Runs every validation + allocates
    ///      the offer id + writes offer fields + stores liquidity.
    ///      Returns the new offer id and the caller's vault address
    ///      so the caller can do the actual asset pull via whichever
    ///      path (safeTransferFrom vs Permit2) fits.
    function _createOfferSetup(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) private returns (uint256 offerId, address vault) {
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
        // governance has not configured the oracle address. Use the
        // resolved `creator` (= msg.sender on classic paths, but the
        // on-behalf-of address on `createOfferInternal`).
        if (LibVaipakam.isSanctionedAddress(creator)) {
            revert ProfileFacet.SanctionedAddress(creator);
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

        // #569 decision D-2 (2026-06-13) — an NFT-rental offer (the lent
        // asset is an NFT) may not use VPFI as its prepay asset. The
        // rental prepay pool is intentionally un-liened (D-1), so VPFI
        // prepay would be drainable through `withdrawVPFIFromVault`
        // with no protection. Gate it at the single shared offer-create
        // chokepoint (covers classic + Permit2 + on-behalf paths).
        if (
            params.assetType != LibVaipakam.AssetType.ERC20 &&
            s.vpfiToken != address(0) &&
            params.prepayAsset == s.vpfiToken
        ) {
            revert VpfiNotAllowedAsRentalPrepay();
        }
        unchecked {
            offerId = ++s.nextOfferId;
        }
        s.userOfferIds[creator].push(offerId);

        // #576 — a refinance-tagged offer is SINGLE-PURPOSE: consumable only by
        // the direct accept-and-refinance path. It may not also opt into the
        // pre-loan parallel sale (#358 borrow-OR-sell): on a carry-over offer
        // the listed collateral is the target loan's already-encumbered NFT, so
        // a sale fill before the refinance accept would transfer it out while
        // the old loan stays Active. Reject the combination up front — BEFORE
        // `_writeOfferFields`' parallel-sale collateral-shape validation — so
        // the verdict is the clear "this is an invalid refinance offer"
        // regardless of collateral type.
        if (params.refinanceTargetLoanId != 0 && params.allowsParallelSale) {
            revert InvalidRefinanceTarget();
        }

        LibVaipakam.Offer storage offer = s.offers[offerId];
        _writeOfferFields(offer, creator, offerId, params);

        // T-092 Phase 2b (#506) — refinance-tagged offer must be a
        // Borrower offer + creator must be the current borrower-NFT
        // owner of the targeted loan + the proposed terms must fit
        // within the borrower's `autoRefinanceCaps[loanId]`.
        // Validation re-runs at accept time too (caps may be
        // tightened or NFT may transfer between create + accept).
        if (params.refinanceTargetLoanId != 0) {
            if (params.offerType != LibVaipakam.OfferType.Borrower) {
                revert InvalidRefinanceTarget();
            }
            // Codex round-2 P2 — partial-fill on a refinance-tagged
            // offer would let it bind to multiple replacement loans
            // (each match rewrites `offerIdToLoanId[offerId]`), so
            // `RefinanceFacet.refinanceLoan` sees only the last
            // match — earlier replacement loans get stranded. Force
            // AON fill so the offer binds exactly once.
            if (params.fillMode != LibVaipakam.FillMode.Aon) {
                revert InvalidRefinanceTarget();
            }
            // (refinance-tagged + allowsParallelSale already rejected up front,
            // before _writeOfferFields — see the guard above.)
            uint256 maxRateEffective =
                params.interestRateBpsMax == 0
                    ? params.interestRateBps
                    : params.interestRateBpsMax;
            uint256 maxAmountEffective =
                params.amountMax == 0 ? params.amount : params.amountMax;
            LibAutoRefinanceCheck.validate(
                s,
                params.refinanceTargetLoanId,
                creator,
                maxRateEffective,
                params.durationDays,
                params.lendingAsset,
                params.collateralAsset,
                params.assetType,
                params.collateralAssetType,
                params.prepayAsset,
                params.amount,
                maxAmountEffective
            );
            // #576 — compute + PERSIST the carry-over decision ONCE, here, at
            // create (after validate has confirmed the asset/type identity +
            // caps). isCarryOver folds in the live-lien + exact
            // collateral-identity checks, so a no-lien or mismatched-collateral
            // target resolves to `false` and takes the legacy fresh-pledge
            // path. Every later site reads this stored flag instead of
            // re-deriving the predicate from the target loan's (mutable)
            // borrower + lien — see Offer.refinanceCarryOver.
            offer.refinanceCarryOver = LibAutoRefinanceCheck.isCarryOver(
                s,
                params.refinanceTargetLoanId,
                creator,
                params.collateralAmount,
                params.collateralAmountMax,
                params.collateralTokenId,
                params.collateralQuantity
            );
            // Pass-2 A1/D5 (#1189, Codex #1233 r2 P2) — a refinance-tagged offer
            // is moot once its target passes the grace deadline: `validate` /
            // RefinanceFacet reject a post-grace refinance, so an offer that
            // outlives that deadline just lingers unfillable and (for a
            // non-carry-over pledge) locks the borrower's fresh collateral until
            // a manual cancel, while wasting lender accept gas. CLAMP the offer's
            // expiry to the target's grace deadline (stamping one when it was
            // open-ended) so it auto-expires there instead. `validate` above has
            // already rejected a past-grace target, so `graceEnd > block.timestamp`
            // and the stamped expiry is a valid future deadline.
            {
                LibVaipakam.Loan storage tgt =
                    s.loans[params.refinanceTargetLoanId];
                uint256 tgtGraceEnd = uint256(tgt.startTime) +
                    uint256(tgt.durationDays) * LibVaipakam.ONE_DAY +
                    LibVaipakam.gracePeriod(tgt.durationDays);
                // Deadline is EXCLUSIVE: `LibVaipakam.isOfferExpired` treats
                // `now >= expiresAt` as expired, while the grace boundary itself
                // (`now == graceEnd`) is still fillable (validate rejects only
                // `now > graceEnd`). Stamp `graceEnd + 1` so an offer created at
                // the boundary stays fillable THROUGH graceEnd instead of being
                // instantly expired (Codex #1233 r3 P3).
                uint256 deadline = tgtGraceEnd + 1;
                if (
                    offer.expiresAt == 0 ||
                    uint256(offer.expiresAt) > deadline
                ) {
                    offer.expiresAt = uint64(deadline);
                }
            }
        }

        LibVaipakam.LiquidityStatus principalLiq = OracleFacet(address(this))
            .checkLiquidity(params.lendingAsset);
        LibVaipakam.LiquidityStatus collateralLiq = OracleFacet(address(this))
            .checkLiquidity(params.collateralAsset);
        offer.principalLiquidity = principalLiq;
        offer.collateralLiquidity = collateralLiq;

        if (!params.creatorRiskAndTermsConsent) revert RiskAndTermsConsentRequired();

        // #671 — progressive risk-access gate at the create chokepoint (shared by
        // every create path). No-op unless the kill-switch is on; protocol-
        // authored lender-sale-vehicle creates are exempt via the `saleVehicleCreate`
        // transient (their risk is the EXITING lender's, already gated at the
        // original loan). The riskier of the two legs governs and NFT rentals
        // tier off the value-bearing prepay token — see `LibRiskAccess`.
        if (LibVaipakam.cfgRiskAccessGateEnabled() && !s.saleVehicleCreate) {
            LibRiskAccess.assertActorMayTransact(
                s,
                creator,
                LibRiskAccess.PairId({
                    lendAsset: params.lendingAsset,
                    lendType: params.assetType,
                    lendTokenId: params.tokenId,
                    collAsset: params.collateralAsset,
                    collType: params.collateralAssetType,
                    collTokenId: params.collateralTokenId,
                    prepayAsset: params.prepayAsset
                })
            );
        }

        // ── System-derived floor/ceiling admission bound (#998 S15 / #900) ──
        // Formerly gated behind the now-dead `rangeAmountEnabled` flag; the
        // bound is now enforced whenever the offer is actually liquid-both-legs
        // ERC-20 (matching the runtime HF gate's scope), via the shared
        // {LibOfferBounds} so create / mutate / internal-match slice cannot
        // drift. The keying (ERC-20 + liquid on both legs) lives in the helper.
        //
        // NOTE: read `params.amountMax` (calldata), NOT `offer.amountMax` — the
        // offer struct's `amountMax` is stamped later in `_createOfferFinish`
        // (`offer.amountMax = params.amountMax`), so it is still 0 here. The
        // old inline block read `offer.amountMax` and was therefore a DEAD
        // check (a 0 amountMax yields floor 0 / ceiling comparison against 0);
        // this fix makes the create-time bound effective for the first time.
        //
        // The lender-sale vehicle stays exempt from the ceiling
        // (`saleVehicleCreate`): it mimics a Borrower offer with
        // `collateralAmount == 0` (real collateral is on the linked live loan).
        LibOfferBounds.assertOfferBounds(
            params.offerType == LibVaipakam.OfferType.Lender,
            params.assetType,
            params.collateralAssetType,
            params.amountMax,
            params.collateralAmount,
            params.collateralAmountMax == 0
                ? params.collateralAmount
                : params.collateralAmountMax,
            params.lendingAsset,
            params.collateralAsset,
            s.saleVehicleCreate
        );

        // ── T-034 — Periodic Interest Payment cadence validation ──────────
        // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
        // Three filters in order:
        //   - Master kill-switch: feature disabled → cadence must be None.
        //   - Filter 0: both sides liquid → otherwise cadence forced to None.
        //   - Filter 1: cadence interval strictly less than duration.
        //   - Filter 2: duration / threshold matrix (mandatory Annual on
        //     >365d loans; finer cadences require principal ≥ threshold).
        _validatePeriodicCadence(params, offer, principalLiq, collateralLiq);

        vault = getUserVault(creator);
    }

    /// @dev T-034 — extracted to keep `_createOfferSetup` readable. Reverts
    ///      on any of the four filter violations per §3 of the design doc.
    ///      Snapshots the lender's chosen cadence onto the Offer struct on
    ///      success.
    function _validatePeriodicCadence(
        LibVaipakam.CreateOfferParams calldata params,
        LibVaipakam.Offer storage offer,
        LibVaipakam.LiquidityStatus principalLiq,
        LibVaipakam.LiquidityStatus collateralLiq
    ) private {
        LibVaipakam.PeriodicInterestCadence cadence =
            params.periodicInterestCadence;
        LibVaipakam.ProtocolConfig storage cfgT034 =
            LibVaipakam.storageSlot().protocolCfg;

        // Master kill-switch: feature off → only None reachable. Reverts
        // before any other validation so the disabled state is the loudest
        // signal.
        if (
            cadence != LibVaipakam.PeriodicInterestCadence.None &&
            !cfgT034.periodicInterestEnabled
        ) {
            revert IVaipakamErrors.PeriodicInterestDisabled();
        }

        // Filter 0 — Periodic Interest Payment requires BOTH legs to be
        // liquid AND ERC-20. NFT lending / NFT collateral / Illiquid
        // classifications all force cadence = None because the auto-
        // liquidate path (PR2) needs DEX-swappable assets. Multi-year
        // illiquid loans do NOT get the mandatory Annual floor — lender
        // accepts that trade-off implicitly via the existing illiquid-
        // asset consent flow.
        bool bothLiquid =
            principalLiq == LibVaipakam.LiquidityStatus.Liquid &&
            collateralLiq == LibVaipakam.LiquidityStatus.Liquid &&
            params.assetType == LibVaipakam.AssetType.ERC20 &&
            params.collateralAssetType == LibVaipakam.AssetType.ERC20;
        if (
            cadence != LibVaipakam.PeriodicInterestCadence.None &&
            !bothLiquid
        ) {
            revert IVaipakamErrors.CadenceNotAllowedForIlliquid(
                uint8(principalLiq),
                uint8(collateralLiq),
                uint8(cadence)
            );
        }

        // Skip Filter 1 + Filter 2 entirely on illiquid-anywhere offers
        // (cadence is None per Filter 0 above; nothing more to enforce)
        // OR on short-duration None-cadence offers (today's behaviour
        // unchanged).
        bool isMultiYear = params.durationDays > 365;
        if (
            cadence == LibVaipakam.PeriodicInterestCadence.None &&
            !isMultiYear
        ) {
            offer.periodicInterestCadence = cadence;
            return;
        }

        // From here on we know either:
        //   (a) cadence != None AND bothLiquid (Filter 0 passed), OR
        //   (b) durationDays > 365 AND bothLiquid (mandatory floor).
        // Resolve the threshold + principal comparison in numeraire-units.
        uint256 threshold = cfgT034.minPrincipalForFinerCadence == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : cfgT034.minPrincipalForFinerCadence;

        // Principal value compared to the threshold uses `params.amount`
        // (= amountMin under range orders) because it is the strict lower
        // bound on what the lender will fund — using `amountMax` here
        // would let a lender qualify for finer cadence with a deceptively
        // large upper bound while never actually filling above the
        // threshold.
        uint256 principalNumeraire = _principalToNumeraire1e18(
            params.lendingAsset,
            params.amount
        );

        // Filter 2 first: row 3 (multi-year, below threshold) requires
        // exactly `Annual`; row 1 (≤1y, below threshold) requires `None`.
        bool aboveThreshold = principalNumeraire >= threshold;
        if (isMultiYear) {
            if (cadence == LibVaipakam.PeriodicInterestCadence.None) {
                // Row 3 / Row 4 both require at least Annual cadence.
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    params.durationDays,
                    principalNumeraire,
                    threshold
                );
            }
            if (
                !aboveThreshold &&
                cadence != LibVaipakam.PeriodicInterestCadence.Annual
            ) {
                // Row 3 — only Annual allowed below threshold on multi-year.
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    params.durationDays,
                    principalNumeraire,
                    threshold
                );
            }
        } else {
            // ≤365d. Row 1 — None only below threshold; Row 2 — opt-in.
            if (
                cadence != LibVaipakam.PeriodicInterestCadence.None &&
                !aboveThreshold
            ) {
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    params.durationDays,
                    principalNumeraire,
                    threshold
                );
            }
        }

        // Filter 1 — interval must be strictly less than duration. Skipped
        // for None (interval=0) since 0 < anything-positive trivially holds
        // and None doesn't have a meaningful interval anyway.
        if (cadence != LibVaipakam.PeriodicInterestCadence.None) {
            uint256 cadenceInterval = LibVaipakam.intervalDays(cadence);
            if (cadenceInterval >= params.durationDays) {
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    params.durationDays,
                    principalNumeraire,
                    threshold
                );
            }
        }

        offer.periodicInterestCadence = cadence;
    }

    /// @dev Convert a raw token amount to numeraire-units (1e18-scaled).
    ///      Single step now after the Numeraire generalization (b1) architectural
    ///      change: `OracleFacet.getAssetPrice` returns numeraire-quoted
    ///      prices natively (governance rotates the underlying Chainlink
    ///      feed addresses + denominator constant when the numeraire
    ///      changes), so this helper just multiplies + scales — no
    ///      second-step boundary conversion via `INumeraireOracle`.
    ///
    ///      Returns 0 if the asset has no oracle coverage — Filter 2
    ///      then treats every offer as "below threshold" for that asset,
    ///      forcing None on ≤365d loans and Annual on multi-year. That
    ///      degrades safely (cadence cannot opt into anything finer than
    ///      what's enforceable on-chain via the existing terminal path).
    function _principalToNumeraire1e18(
        address asset,
        uint256 amount
    ) private view returns (uint256) {
        if (asset == address(0) || amount == 0) return 0;
        try OracleFacet(address(this)).getAssetPrice(asset) returns (
            uint256 price,
            uint8 feedDecimals
        ) {
            uint8 tokenDecimals = IERC20Metadata(asset).decimals();
            return (amount * price * 1e18) /
                (10 ** feedDecimals) /
                (10 ** tokenDecimals);
        } catch {
            return 0;
        }
    }

    /// @dev Classic-path asset pull: the big if/else that lives in
    ///      {createOffer}. Handles every combination of offer side +
    ///      asset type. Permit2 callers skip this and invoke
    ///      `LibPermit2.pull` with the signed permit instead.
    ///
    ///      ERC-20 deposits route through
    ///      `VaultFactoryFacet.vaultDepositERC20` (the protocol-wide
    ///      chokepoint) so the `protocolTrackedVaultBalance` counter
    ///      ticks at every legitimate inflow. NFTs (ERC-721 / ERC-1155)
    ///      bypass the counter — they're tracked per-loan via
    ///      `loan.collateralAsset / tokenId / quantity` references
    ///      rather than fungible balance, so the counter doesn't
    ///      apply to them. The `vault` argument stays in the
    ///      signature because NFT receivers still target it directly.
    function _pullCreatorAssetsClassic(
        uint256 offerId,
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        address vault
    ) private {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                // Range Orders Phase 1: pre-vault the upper bound
                // (`amountMax`) so subsequent partial fills draw from
                // the lender's already-locked custody. Auto-collapse
                // (params.amountMax == 0 → params.amount) keeps legacy
                // single-value callers byte-identical.
                uint256 lenderPull = params.amountMax == 0
                    ? params.amount
                    : params.amountMax;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultDepositERC20.selector,
                        creator,
                        params.lendingAsset,
                        lenderPull
                    ),
                    VaultDepositFailed.selector
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC721) {
                IERC721(params.lendingAsset).safeTransferFrom(
                    creator,
                    vault,
                    params.tokenId
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC1155) {
                IERC1155(params.lendingAsset).safeTransferFrom(
                    creator,
                    vault,
                    params.tokenId,
                    params.quantity,
                    ""
                );
            } else {
                revert InvalidAssetType();
            }
        } else {
            // Borrower: lock collateral (or prepay for NFT rental).
            // #951 (Codex #959) — a protocol-authored lender-sale vehicle pledges
            // NO fresh collateral: the real collateral stays on the linked live
            // loan and the exiting-lender creator does not own it. Any pull here —
            // the ERC20 collateral deposit OR the ERC721/ERC1155 `safeTransferFrom`
            // below — would revert (and the ceiling exemption alone doesn't stop
            // the pull). Skip the entire borrower-side pull, mirroring the
            // carry-over refinance skip. The zero-fresh-collateral invariant is
            // enforced upstream (`collateralAmount == 0` in `_buildSaleParams`).
            if (LibVaipakam.storageSlot().saleVehicleCreate) return;
            if (params.assetType == LibVaipakam.AssetType.ERC20) {
                // #576 — a CARRY-OVER refinance offer reuses the OLD loan's
                // collateral IN PLACE (the non-transferred predicate
                // guarantees it's already in this creator's vault), and
                // `RefinanceFacet` retags the lien old→new. So it must NOT
                // pre-vault a second batch — the 2x lock this removes. Only the
                // carry-over case skips; transferred / ranged / untagged offers
                // pledge fresh collateral and take the legacy refinance path.
                // Nothing else is pulled on this branch, so returning early is
                // the complete skip. Reads the PERSISTED create-time decision
                // (set in `_createOfferSetup`) — never re-derives.
                if (
                    LibVaipakam.storageSlot().offers[offerId].refinanceCarryOver
                ) return;
                if (params.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    // Issue #164 — pre-vault the upper bound
                    // (`collateralAmountMax`) so the borrower-range
                    // case mirrors the lender-side amount-range pull:
                    // OfferMatchFacet's excess-refund hook returns the
                    // unused tail to the borrower's wallet at match-
                    // time. Auto-collapse (zero ⇒ collateralAmount)
                    // keeps legacy single-value callers byte-identical.
                    uint256 borrowerPull = params.collateralAmountMax == 0
                        ? params.collateralAmount
                        : params.collateralAmountMax;
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultDepositERC20.selector,
                            creator,
                            params.collateralAsset,
                            borrowerPull
                        ),
                        VaultDepositFailed.selector
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(params.collateralAsset).safeTransferFrom(
                        creator,
                        vault,
                        params.collateralTokenId
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(params.collateralAsset).safeTransferFrom(
                        creator,
                        vault,
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
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultDepositERC20.selector,
                        creator,
                        params.prepayAsset,
                        totalPrepay
                    ),
                    VaultDepositFailed.selector
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
            // Range Orders Phase 1: pre-vault `amountMax` so partial
            // fills draw from custody. Auto-collapse for legacy callers.
            return params.amountMax == 0 ? params.amount : params.amountMax;
        }
        if (params.assetType == LibVaipakam.AssetType.ERC20) {
            // Issue #164 — Permit2 pulls the upper bound so the
            // borrower-range path matches the classic-path pre-vault.
            // Auto-collapse for legacy single-value callers.
            return params.collateralAmountMax == 0
                ? params.collateralAmount
                : params.collateralAmountMax;
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
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];

        unchecked {
            offer.positionTokenId = ++s.nextTokenId;
        }
        // Reverse map: tokenId → offerId. Mirrors the loan-side
        // `loanIdByPositionTokenId` populated by LibMetricsHooks at
        // LoanInitiated. Lets MetricsFacet's `getUserPositionOffers`
        // view enumerate offers whose creator-NFT a given user holds
        // (including secondary-market recipients). Cleared at offer
        // cancel and at accept (when the tokenId transitions to a
        // loan and `loanIdByPositionTokenId` takes over).
        s.offerIdByPositionTokenId[offer.positionTokenId] = offerId;
        (bool success, ) = address(VaipakamNFTFacet(address(this))).call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                creator,
                offer.positionTokenId,
                offerId,
                0,
                params.offerType == LibVaipakam.OfferType.Lender,
                LibVaipakam.LoanPositionStatus.OfferCreated
            )
        );
        if (!success) revert NFTMintFailed();

        // Offer-creator escrow lock. An offer pre-vaults the creator's
        // ERC20 stake into their own vault at create-time (the pull ran
        // before this finish step). Mark it encumbered in the same
        // `encumbered[user][asset][0]` aggregate the vault-withdraw
        // chokepoint reads, so the creator cannot withdraw the locked
        // stake out from under a still-open offer. An offer has exactly
        // ONE creator-side escrow, so the single `offerPrincipalLien`
        // primitive serves both legs (asset-agnostic):
        //   - T-407-C (#566): ERC20 Lender offer → its `amountMax`
        //     principal in `lendingAsset`.
        //   - #573 (security): ERC20-borrow Borrower offer with ERC20
        //     collateral → its `collateralAmountMax` in `collateralAsset`.
        //     Closes the pre-acceptance drain (e.g. `withdrawVPFIFromVault`
        //     unstaking VPFI pledged as collateral before a lender accepts,
        //     which would mint an under-collateralized loan).
        // Released on cancel / single-fill accept / dust-close /
        // lazy-expiry, decremented per partial fill, and (borrower leg)
        // handed off to the loan-collateral lien at acceptance. NFT
        // legs hold the token itself in custody (no fungible aggregate,
        // no ERC20 drain door) so they're out of scope. `_creatorPullAmount`
        // returns the exact pre-vaulted amount for each shape — reused so
        // the lien can never drift from what was actually pulled.
        if (
            params.offerType == LibVaipakam.OfferType.Lender &&
            params.assetType == LibVaipakam.AssetType.ERC20
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.createOfferPrincipalLien.selector,
                    offerId,
                    creator,
                    params.lendingAsset,
                    _creatorPullAmount(offerId, params)
                ),
                bytes4(0)
            );
        } else if (
            params.offerType == LibVaipakam.OfferType.Borrower &&
            params.assetType == LibVaipakam.AssetType.ERC20 &&
            params.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
            !LibVaipakam.storageSlot().offers[offerId].refinanceCarryOver
        ) {
            // #576 — a CARRY-OVER refinance offer pledged NO fresh collateral
            // (the carry-over skip in `_pullCreatorAssetsClassic`), so there is
            // nothing to escrow-lock here. Locking would encumber
            // `collateralAmountMax` of collateral that was never deposited — a
            // phantom lien double-counting the carried collateral (already
            // liened under the OLD loan, retagged at refinance). The
            // `!isCarryOver` guard keeps the #573 escrow lock for every ordinary
            // Borrower offer (incl. transferred / ranged / untagged refinances,
            // which DO pledge fresh collateral).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.createOfferPrincipalLien.selector,
                    offerId,
                    creator,
                    params.collateralAsset,
                    _creatorPullAmount(offerId, params)
                ),
                bytes4(0)
            );
        }

        LibMetricsHooks.onOfferCreated(offer);

        emit OfferCreated(offerId, creator, params.offerType);
        _emitOfferCreatedDetails(offerId, creator);
    }

    /// @dev Emits {OfferCreatedDetails}. Factored out + populated
    ///      field-by-field on a memory struct to dodge viaIR's
    ///      stack-too-deep at the emit site.
    function _emitOfferCreatedDetails(uint256 offerId, address creator) internal {
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];

        OfferCreatedFields memory f;
        f.offerType = offer.offerType;
        f.assetType = offer.assetType;
        f.collateralAssetType = offer.collateralAssetType;
        f.amount = offer.amount;
        f.tokenId = offer.tokenId;
        f.collateralAsset = offer.collateralAsset;
        f.collateralAmount = offer.collateralAmount;
        f.interestRateBps = offer.interestRateBps;
        f.durationDays = offer.durationDays;
        // Issue #102 / ADR-0010 §3 — indexers see the LOGICAL borrower
        // amount ceiling, never the storage default. The GTC default
        // ships `amountMax = 0` on borrower offers and derives the
        // effective ceiling at match-time from `collateralAmountMax ×
        // effective init-LTV cap`. Apply the same collapse here so the
        // event payload mirrors what `previewMatch` sees, sparing
        // indexers from having to re-derive (and from observing the raw
        // storage 0). Lender offers always have `amountMax > 0` (pre-
        // vault requirement) so the conditional is a no-op for them.
        if (offer.amountMax == 0
            && offer.offerType == LibVaipakam.OfferType.Borrower) {
            uint8 effTier = OracleFacet(address(this))
                                .getEffectiveLiquidityTier(offer.collateralAsset);
            uint256 maxLtv  = LibVaipakam.storageSlot()
                                .assetRiskParams[offer.collateralAsset]
                                .loanInitMaxLtvBps;
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(effTier));
            uint256 cap     = maxLtv < tierCap ? maxLtv : tierCap;
            uint256 borrowerCollMax = offer.collateralAmountMax == 0
                ? offer.collateralAmount
                : offer.collateralAmountMax;
            f.amountMax = LibRiskMath.maxLendingForLtvCap(
                borrowerCollMax,
                offer.lendingAsset,
                offer.collateralAsset,
                cap
            );
        } else {
            f.amountMax = offer.amountMax;
        }
        f.interestRateBpsMax = offer.interestRateBpsMax;
        // Issue #169 follow-up — indexers see the LOGICAL upper bound,
        // never the storage default. The single-value-SSTORE-skip
        // optimisation in `_writeOfferCollateralFields` leaves
        // `offer.collateralAmountMax == 0` on legacy / single-value
        // offers; apply the same `0 ⇒ collateralAmount` collapse here
        // so the event payload mirrors what every read site (preview,
        // refund, cancel) sees. Without this, indexers would have to
        // know about the SSTORE-skip — leaky abstraction.
        f.collateralAmountMax = offer.collateralAmountMax == 0
            ? offer.collateralAmount
            : offer.collateralAmountMax;
        f.creatorRiskAndTermsConsent = offer.creatorRiskAndTermsConsent;
        f.allowsPartialRepay = offer.allowsPartialRepay;
        f.periodicInterestCadence = offer.periodicInterestCadence;
        f.expiresAt = offer.expiresAt;
        f.fillMode = offer.fillMode;
        // T-086 step 4 — companion-event surface for the lender's
        // prepay-listing consent. Carried so indexer / frontend cache
        // merges can render the offer's "borrower may post a prepay
        // listing" decoration without a follow-up `getOffer` view-call.
        f.allowsPrepayListing = offer.allowsPrepayListing;
        // T-092 Phase 2b (Codex round-1 P2) — carry the refinance
        // target on the companion event so indexers + the dapp can
        // distinguish refinance-tagged Borrower offers from standard
        // ones without a follow-up `getOffer` view-call.
        f.refinanceTargetLoanId = offer.refinanceTargetLoanId;

        emit OfferCreatedDetails(offerId, creator, offer.lendingAsset, f);
    }

    /**
     * @dev Writes the ~18 offer fields in two frames so `forge coverage
     *      --ir-minimum` (no optimizer) doesn't pile every calldata load
     *      onto a single stack frame in {createOffer}.
     */
    function _writeOfferFields(
        LibVaipakam.Offer storage offer,
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        _writeOfferPrincipalFields(offer, creator, offerId, params);
        _writeOfferCollateralFields(offer, params);
    }

    function _writeOfferPrincipalFields(
        LibVaipakam.Offer storage offer,
        address creator,
        uint256 offerId,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.id = offerId;
        offer.creator = creator;
        offer.offerType = params.offerType;
        offer.lendingAsset = params.lendingAsset;
        offer.amount = params.amount;
        offer.interestRateBps = params.interestRateBps;
        offer.durationDays = params.durationDays;
        offer.assetType = params.assetType;
        offer.tokenId = params.tokenId;
        offer.quantity = params.quantity;
        offer.prepayAsset = params.prepayAsset;
        // ── Canonical Limit-Order Phase 2 (#183, see
        //    docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md):
        //    the Phase 1 auto-collapse (`amountMax == 0 → amount`) is
        //    dropped. Callers MUST ship explicit non-zero values for
        //    `amount`, `amountMax`, `interestRateBpsMax`. The canonical
        //    frontend always does so per the role-aware mapping
        //    (lender ships `amount = minPartialFillAmount`, `amountMax
        //    = lendingAmount`; borrower ships `amount = lendingAmount`
        //    min, `amountMax = derived from collateral × tier-LTV`).
        //
        //    The Phase 1 kill-switches that blocked range offers at
        //    create time (`rangeAmountEnabled`, `rangeRateEnabled`,
        //    `rangeCollateralEnabled`) are removed — every Phase 2
        //    offer is canonically a range (lender amount differs from
        //    amountMax via the minPartialFill rule), so the OFF state
        //    would block every legitimate offer. The flags remain in
        //    `ProtocolConfig` as dead-config until a follow-up card
        //    sweeps them. `partialFillEnabled` keeps its runtime role
        //    in `OfferMatchFacet.matchOffers` (matching is the gated
        //    operation, not create).
        if (params.amount == 0) revert AmountMustBePositive();
        if (params.amountMax == 0) revert AmountMaxMustBePositive();
        if (params.amountMax < params.amount) revert InvalidAmountRange();
        // #183 — the rate invariant deliberately ALLOWS zero on both
        // ends (`interestRateBps = interestRateBpsMax = 0`). This is a
        // legitimate shape: NFT rental offers don't carry an APR (the
        // economic payment flows through `amount × durationDays` prepay
        // + buffer, not interest accrual), and no-interest ERC20 loans
        // are also valid. The `> 0` strictness we apply to amount +
        // collateral catches silent-zero bugs there because a zero
        // principal or collateral is structurally meaningless, whereas
        // a zero rate is structurally meaningful. The only rate
        // checks that stay load-bearing are the range ordering and the
        // upper-sanity ceiling (`<= MAX_INTEREST_BPS`).
        if (params.interestRateBpsMax < params.interestRateBps) revert InvalidRateRange();
        if (params.interestRateBpsMax > LibVaipakam.MAX_INTEREST_BPS) {
            revert InterestRateAboveCeiling();
        }
        offer.amountMax = params.amountMax;
        offer.interestRateBpsMax = params.interestRateBpsMax;
        // #400 — NOTE: the rate a human creator types is BINDING and is NOT
        // transformed by any rate model. Vaipakam's market rate is set by the
        // human-driven P2P order book (price discovery), not a protocol curve —
        // overwriting a creator's rate here would erase that differentiation.
        // The pluggable {IRateModel} is exposed as a QUOTE (`quoteOfferRateBps`
        // below) for (a) dApp rate *guidance* a human may take or ignore, and
        // (b) automated/delegated pricing (#393 auto-lend / auto-roll /
        // keeper-posted intents, #394 risk premiums) where the user opted into
        // having their liquidity priced for them. Those callers pass the quote
        // result as the offer rate themselves; this manual create path never
        // calls the model.
        offer.amountFilled = 0;
        offer.createdAt = uint64(block.timestamp);

        // ── #195 — GTT / offer-expiry validation + stamp ──────────────
        // `expiresAt == 0` is the GTC sentinel (preserves pre-#195
        // behaviour). Any non-zero value must lie strictly after now
        // and within the protocol's horizon cap, both bounds enforced
        // at create time so the storage row is always either GTC or
        // within a bounded grief window. The non-strict lower bound
        // (`<=`) catches "set expiresAt to now" — that would create an
        // offer that's expired on creation, which is at-best useless
        // and at-worst a UX foot-gun. `isOfferExpired` uses `>=` so
        // the boundary is consistent on both write and read.
        if (params.expiresAt != 0) {
            if (uint256(params.expiresAt) <= block.timestamp) {
                revert OfferExpiryInPast();
            }
            if (
                uint256(params.expiresAt) >
                block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON
            ) {
                revert OfferExpiryAboveCap(
                    params.expiresAt,
                    block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON
                );
            }
            offer.expiresAt = params.expiresAt;
        }
        // `expiresAt == 0` path: leave the storage slot at its default
        // zero. Skipping the SSTORE on the GTC path keeps `createOffer`
        // gas identical to pre-#195 for every existing test / script
        // that doesn't set the field.

        // ── #125 — Fill-mode validation + stamp ─────────────────────────
        // `Partial` (0) is the backward-compat default — every legacy
        // CreateOfferParams construction that doesn't set the field
        // gets today's Range-Orders Phase-1 behaviour.
        //
        // `Aon` requires `amount == amountMax`. A non-trivial range
        // under AON is structurally meaningless: the only fill that
        // ever lands is the full one, so any min/max gap would never
        // be observable. Forcing single-value at create keeps the
        // match-time AON gate (revert on any matchAmount < offer
        // total) unambiguous + cheap (no need to thread "the AON
        // amount" through the matcher midpoint logic).
        //
        // `Ioc` requires `expiresAt > 0`. IOC's defining knob IS the
        // window — "match what's available within N seconds, cancel
        // the rest"; an IOC without a window is just `Partial` with
        // extra metadata. The actual time-window enforcement is
        // shared with #195's GTT lazy-expiry gate (`isOfferExpired`
        // fires at every accept / match read), so we don't add a
        // separate runtime path here.
        if (params.fillMode == LibVaipakam.FillMode.Aon) {
            if (params.amount != params.amountMax) {
                revert AonRequiresSingleValueAmount();
            }
        } else if (params.fillMode == LibVaipakam.FillMode.Ioc) {
            if (params.expiresAt == 0) revert IocRequiresExpiry();
        }
        if (params.fillMode != LibVaipakam.FillMode.Partial) {
            // Skip the SSTORE on the Partial default for the same gas-
            // identity reason as `expiresAt == 0` above.
            offer.fillMode = params.fillMode;
        }
    }

    function _writeOfferCollateralFields(
        LibVaipakam.Offer storage offer,
        LibVaipakam.CreateOfferParams calldata params
    ) private {
        offer.collateralAsset = params.collateralAsset;
        offer.collateralAmount = params.collateralAmount;
        offer.creatorRiskAndTermsConsent = params.creatorRiskAndTermsConsent;
        offer.collateralAssetType = params.collateralAssetType;
        offer.collateralTokenId = params.collateralTokenId;
        offer.collateralQuantity = params.collateralQuantity;
        // Lender-controlled gate for borrower-initiated partial repay.
        // See {CreateOfferParams.allowsPartialRepay} for full semantics.
        offer.allowsPartialRepay = params.allowsPartialRepay;
        // T-086 step 4 — lender consent to allow a borrower-initiated
        // Seaport prepay listing on the loan's collateral NFT. See
        // {CreateOfferParams.allowsPrepayListing} for full semantics.
        // Snapshotted to {Loan.allowsPrepayListing} at loan-init.
        offer.allowsPrepayListing = params.allowsPrepayListing;
        // T-086 Round-8 (#358) §19.5 — borrower opt-in for parallel-sale
        // listing. Only valid on Borrower offers with NFT collateral;
        // the call to OfferParallelSaleFacet.postParallelSaleListing
        // re-validates these constraints at post time, but we enforce
        // the structurally-impossible cases at create time so the flag
        // can't be stamped on an offer it'll never be usable on.
        // Codex P1 round-1 #4 fix — the missing wiring made every
        // production offer keep allowsParallelSale == false.
        if (params.allowsParallelSale) {
            if (offer.offerType != LibVaipakam.OfferType.Borrower) {
                revert ParallelSaleRequiresBorrowerOffer();
            }
            if (
                offer.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
                offer.collateralAssetType != LibVaipakam.AssetType.ERC1155
            ) {
                revert ParallelSaleRequiresNFTCollateral();
            }
            // Codex round-8 P2 #4 — mirror the post-time
            // `ParallelSaleRequiresSingleFill` check at create time
            // (`fillMode != Aon` is incompatible with parallel-sale's
            // single-loan assumption). Without this gate, a borrower
            // can stamp an offer as parallel-sale-enabled with
            // `Partial` or `IOC` fillMode + finds out only at
            // `postParallelSaleListing` time that the listing can never
            // post — misleading UX, looks like a borrow-OR-sell
            // option in the offer's terms but is unusable.
            if (offer.fillMode != LibVaipakam.FillMode.Aon) {
                revert ParallelSaleRequiresAonFillMode();
            }
        }
        offer.allowsParallelSale = params.allowsParallelSale;
        // T-092 Phase 2b (#506) — refinance target.
        offer.refinanceTargetLoanId = params.refinanceTargetLoanId;
        // #408 / #410 / #413 (2026-06-12) — floor-model election.
        // Carries through to `Loan.useFullTermInterest` at loan-init
        // (`LoanFacet.initiateLoan:792`), which `LibEntitlement.
        // settlementInterest` reads to apply the full-term FLOOR
        // (when `true`) or pure pro-rata-elapsed (when `false`).
        offer.useFullTermInterest = params.useFullTermInterest;
        // Phase 6: keeper access is per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. Creator enables specific
        // keepers post-create via `ProfileFacet.setOfferKeeperEnabled`.

        // ── Canonical Limit-Order Phase 2 (#183) — same shape as the
        //    amount/rate block above. Auto-collapse dropped; explicit
        //    non-zero `collateralAmountMax` required from every caller.
        //    Lender offers stay single-value on collateral
        //    (`collateralAmount == collateralAmountMax`) per #164's
        //    framing — the lender's collateralAmount IS their derived
        //    requirement; a separate max wouldn't add meaning. Borrower
        //    offers are RANGED on collateral (their `collateralAmount`
        //    is the derived floor matching their `amount` floor; their
        //    `collateralAmountMax` is the user's posted max commit).
        //    The `rangeCollateralEnabled` create-time kill-switch is
        //    removed (every Phase 2 borrower offer would be blocked
        //    under OFF since collateral is canonically ranged).
        // #183 — `collateralAmount > 0` and `collateralAmountMax > 0`
        // enforced ONLY for true ERC-20 LOANS (both legs ERC-20) AND
        // not the lender-sale-vehicle / no-collateral pattern. Three
        // cases get a pass:
        //   1. NFT collateral (ERC721 / ERC1155) — the lock is the
        //      `collateralTokenId` / `(tokenId, quantity)` pair, not
        //      an "amount"; `collateralAmount` is structurally unused.
        //   2. NFT-rental offers (`assetType` is ERC721 / ERC1155) —
        //      the rental fee (`amount × durationDays`) IS the
        //      economic commitment; collateral is optional.
        //   3. Lender sale-vehicle / no-collateral lender offers
        //      shipped as `collateralAmount == 0 == collateralAmountMax`
        //      (BOTH zero, explicit). The actual collateral on these
        //      flows comes from a linked loan via
        //      `s.saleOfferToLoanId[offerId]` (read inline at accept
        //      time, see OfferAcceptFacet `_calculateTransactionValueNumeraire`
        //      and the EarlyWithdrawal sale-completion path). Mixed
        //      shapes (one zero, the other positive) still revert.
        // ERC-20 lending against ERC-20 collateral with at least one
        // non-zero collateral field is the only shape where the auto-
        // collapse fallback could mask a real silent-zero bug, so
        // that's the only shape we strictly enforce.
        if (
            params.assetType == LibVaipakam.AssetType.ERC20
            && params.collateralAssetType == LibVaipakam.AssetType.ERC20
            && !(params.collateralAmount == 0 && params.collateralAmountMax == 0)
        ) {
            if (params.collateralAmount == 0) revert CollateralMustBePositive();
            if (params.collateralAmountMax == 0) revert CollateralAmountMaxMustBePositive();
        }
        if (params.collateralAmountMax < params.collateralAmount) {
            revert InvalidCollateralAmountRange();
        }
        if (
            params.offerType == LibVaipakam.OfferType.Lender
            && params.collateralAmountMax != params.collateralAmount
        ) {
            revert LenderCollateralRangeNotAllowed();
        }
        // Canonical Limit-Order Phase 2 (#183) — the Phase 1 #169
        // SSTORE-skip optimisation is retired. Under the strict
        // invariant `collateralAmountMax >= collateralAmount > 0`,
        // storage always holds an explicit non-zero value (the
        // canonical frontend ships the user's max collateral commit;
        // lender single-value offers ship it equal to
        // `collateralAmount`). The read-side `collateralAmountMax == 0
        //  ⇒ collateralAmount` fallbacks elsewhere in this facet are
        // dead code under the new invariant; they stay as defensive
        // no-ops and will get swept in a follow-up.
        offer.collateralAmountMax = params.collateralAmountMax;
        // `collateralAmountFilled` defaults to 0 from struct
        // initialization; it stays 0 across Phase 1 borrower matches
        // (single-fill rule). #102 lifts the single-fill rule and
        // starts writing this field.
    }

    /**
     * @notice Resolve (creating lazily) a user's per-user vault proxy.
     * @dev Public Diamond entrypoint, retained on this facet post-split
     *      (Issue #67). The cross-facet wrapper body now lives in
     *      {LibUserVault.getOrCreate} so `OfferAcceptFacet` can share it
     *      without re-hosting the selector. Reverts GetUserVaultFailed
     *      on cross-facet call failure.
     * @param user The user whose vault to resolve (created lazily).
     * @return proxy The user's vault proxy address.
     */
    function getUserVault(address user) public returns (address proxy) {
        return LibUserVault.getOrCreate(user);
    }

}
