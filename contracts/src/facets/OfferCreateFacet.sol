// src/facets/OfferCreateFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {LibOfferCreate} from "../libraries/LibOfferCreate.sol";
import {LibOfferAdmission} from "../libraries/LibOfferAdmission.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {LibUserVault} from "../libraries/LibUserVault.sol";

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
 *      offer ({PrecloseOffsetFacet.completeOffset}) atomically.
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
        // ── #3621 — the lender's "either" marks ({LibVaipakam.Offer.lifecycleFlex}),
        //    so a cache can show which borrower settings the offer also takes.
        uint8 lifecycleFlex;
        // ── #3719 — the integrator named at creation (address(0) = none), so
        //    the platform's alert can name the door the user came through. On a
        //    lender's offer it is attribution only and earns no share.
        address integrator;
        // ── #3635 A — the market link on the rate limit (0 / 0 = none).
        uint8 linkKind;
        int16 linkMarginBps;
        // ── #3719 / #3713 — the warnings the contract derived at creation:
        //    bit 1 the checked rate (a lender's floor, a borrower's ceiling)
        //    is far above the term average, bit 2 far below. Bit 0 is
        //    reserved for the collateral-concentration warning, which only
        //    the loan-opened event carries. Never a caller input.
        uint8 warnings;
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
    ///      `acceptOffer` / `PrecloseFacet.transferObligationViaOffer`
    ///      wrappers around the shared
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
    // The offer-shape errors (amount, rate and collateral ranges, the rental
    // and all-or-nothing single-value rules) are declared in {LibOfferShape},
    // which both this facet and `OfferMutateFacet` check through (#2749). An
    // error's selector is its name and parameter types, so each kept its
    // selector when it moved.
    /// `params.fillMode == Ioc && params.expiresAt == 0`. IOC's defining
    /// knob is the time window; an IOC without an `expiresAt` is just a
    /// Partial offer with extra metadata. Reject loud rather than let
    /// the creator post an unreachable IOC configuration.
    error IocRequiresExpiry();

    // ── Range Orders Phase 1 errors (docs/RangeOffersDesign.md §5.5) ─
    /// #902 — an ERC-1155 rental offer's `quantity` exceeds what the lender's
    /// vault can record for one rental (a `uint128`, the width of a rental
    /// row's quantity). Refused at create so no standing offer vaults units
    /// that every accept would then refuse to record.
    error RentalQuantityAboveVaultRange();
    // ── Canonical Limit-Order Phase 2 errors (#183) — strict
    //    non-zero invariants replacing the dropped auto-collapse.
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
     * @param validUntil The caller's deadline (unix seconds) for this
     *        transaction, MANDATORY (#3412): posting an offer is
     *        price-exposed, so a transaction that waited in a queue and lands
     *        after it reverts instead of posting terms the creator no longer
     *        wants. Checked by `LibTiming.requireDeadline`, the one rule every
     *        price-exposed entry uses. Distinct from `params.expiresAt`, which
     *        is how long the posted OFFER lives.
     * @return offerId The ID of the created offer.
     */
    function createOffer(
        LibVaipakam.CreateOfferParams calldata params,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        LibTiming.requireDeadline(validUntil);
        (offerId, ) = LibOfferCreate.setup(msg.sender, params);
        _pullCreatorAssetsClassic(offerId, msg.sender, params);
        LibOfferCreate.finish(msg.sender, offerId, params, LibOfferAdmission.Route.UserPosted);
    }

    /// @notice Cross-facet entry used exclusively by
    ///         `PrecloseOffsetFacet.offsetWithNewOffer` (Option 3 offset
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
        (offerId, ) = LibOfferCreate.setup(creator, params);
        _pullCreatorAssetsClassic(offerId, creator, params);
        LibOfferCreate.finish(creator, offerId, params, LibOfferAdmission.Route.OnBehalf);
    }

    /// @notice #3328 — Diamond-only entry `CollectionOfferFacet` uses to post
    ///         a collection offer's parent: the creator's own posting (book
    ///         bounds and the open-offer cap apply, counted once), with the
    ///         principal of every loan pulled from the creator's wallet.
    /// @dev    Like {createOfferInternal}, `creator` is the real caller of the
    ///         outer entry, which holds the reentrancy guard.
    function createCollectionParent(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        (offerId, ) = LibOfferCreate.setup(creator, params);
        _pullCreatorAssetsClassic(offerId, creator, params);
        LibOfferCreate.finish(creator, offerId, params, LibOfferAdmission.Route.UserPosted);
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
     * @param validUntil The caller's MANDATORY transaction deadline, exactly
     *        as {createOffer}.
     * @return offerId  The created offer's id.
     */
    function createOfferWithPermit(
        LibVaipakam.CreateOfferParams calldata params,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 offerId) {
        LibTiming.requireDeadline(validUntil);
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
        (offerId, vault) = LibOfferCreate.setup(msg.sender, params);
        uint256 amount = LibOfferCreate.creatorPullAmount(offerId, params);
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
            LibOfferCreate.finish(msg.sender, offerId, params, LibOfferAdmission.Route.UserPosted);
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
        LibOfferCreate.finish(msg.sender, offerId, params, LibOfferAdmission.Route.UserPosted);
    }

    /// @dev Classic-path asset pull: the big if/else that lives in
    ///      {createOffer}. Handles every combination of offer side +
    ///      asset type. Permit2 callers skip this and invoke
    ///      `LibPermit2.pull` with the signed permit instead.
    ///
    ///      Every deposit routes through the vault's own deposit entries
    ///      (`VaultFactoryFacet.vaultDepositERC20` for ERC-20s, and
    ///      `vaultDepositERC721` / `vaultDepositERC1155` via
    ///      {LibFacet.depositNftToVault} for NFTs, #3539), which measure the
    ///      arrival before the tracked ledger records it, so an offer never
    ///      stands on an asset its vault does not hold.
    function _pullCreatorAssetsClassic(
        uint256 offerId,
        address creator,
        LibVaipakam.CreateOfferParams calldata params
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
            } else if (
                params.assetType == LibVaipakam.AssetType.ERC721
                    || params.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                LibFacet.depositNftToVault(
                    params.assetType, params.lendingAsset, creator, params.tokenId, params.quantity
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
                } else if (
                    params.collateralAssetType == LibVaipakam.AssetType.ERC721
                        || params.collateralAssetType == LibVaipakam.AssetType.ERC1155
                ) {
                    LibFacet.depositNftToVault(
                        params.collateralAssetType,
                        params.collateralAsset,
                        creator,
                        params.collateralTokenId,
                        params.collateralQuantity
                    );
                } else {
                    revert InvalidAssetType();
                }
            } else if (
                params.assetType == LibVaipakam.AssetType.ERC721 ||
                params.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                // #1193 — at create-time the live config IS the value just
                // snapshotted onto the offer (`rentalBufferBpsAtCreate`), so the
                // deposit funds exactly what the snapshot records.
                uint256 totalPrepay = LibOfferCreate.nftRentalPrepayTotal(
                    params.amount, params.durationDays, LibVaipakam.cfgRentalBufferBps()
                );
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
