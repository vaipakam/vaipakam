// src/facets/OfferCreateFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
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
import {ProfileFacet} from "./ProfileFacet.sol";
import {LibUserEscrow} from "../libraries/LibUserEscrow.sol";

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
        bool creatorRiskAndTermsConsent;
        bool allowsPartialRepay;
        LibVaipakam.PeriodicInterestCadence periodicInterestCadence;
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
    // NotOfferCreator inherited from IVaipakamErrors
    error InsufficientAllowance();
    error LiquidityMismatch();
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

    // `CancelCooldownActive` moved to `OfferCancelFacet` along with
    // `cancelOffer` (Range Orders Phase 1 OfferFacet split for
    // EIP-170).

    /**
     * @notice Creates a new lender or borrower offer.
     * @dev Deposits/locks the creator-side asset into the creator's per-user
     *      escrow via {EscrowFactoryFacet}:
     *        - Lender/ERC-20: `amount` of `lendingAsset`.
     *        - Lender/ERC-721 or ERC-1155: the NFT itself (custody-based rental).
     *        - Borrower/ERC-20 loan: collateral in its declared asset type.
     *        - Borrower/NFT rental: prepay + 5% buffer in `prepayAsset`.
     *      Re-checks liquidity on both legs via OracleFacet and latches
     *      the verdict into the offer. `creatorRiskAndTermsConsent` is mandatory
     *      on every create (docs/WebsiteReadme.md §"Offer and acceptance
     *      risk warnings" + README.md §"Liquidity & Asset Classification");
     *      missing consent reverts RiskAndTermsConsentRequired before any
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
        (offerId, escrow) = _createOfferSetup(msg.sender, params);
        _pullCreatorAssetsClassic(msg.sender, params, escrow);
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
    ///         (e.g. Alice for offsetWithNewOffer) so every helper
    ///         operates on her behalf instead of the Diamond's.
    function createOfferInternal(
        address creator,
        LibVaipakam.CreateOfferParams calldata params
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        address escrow;
        (offerId, escrow) = _createOfferSetup(creator, params);
        _pullCreatorAssetsClassic(creator, params, escrow);
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

        address escrow;
        (offerId, escrow) = _createOfferSetup(msg.sender, params);
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
        // Permit2 already moved funds to the user's escrow. Record
        // the deposit in the protocolTrackedEscrowBalance counter so
        // it stays the symmetric mirror of the classic-path
        // `escrowDepositERC20` flow above. Every Permit2-funded leg
        // here is ERC-20 (the asset-type guards at the top of the
        // function reject any other shape), so the counter is the
        // right home for it.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.recordEscrowDepositERC20.selector,
                msg.sender,
                expectedAsset,
                amount
            ),
            EscrowDepositFailed.selector
        );
        _createOfferFinish(msg.sender, offerId, params);
    }

    /// @dev Shared pre-pull setup. Runs every validation + allocates
    ///      the offer id + writes offer fields + stores liquidity.
    ///      Returns the new offer id and the caller's escrow address
    ///      so the caller can do the actual asset pull via whichever
    ///      path (safeTransferFrom vs Permit2) fits.
    function _createOfferSetup(
        address creator,
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
        unchecked {
            offerId = ++s.nextOfferId;
        }
        s.userOfferIds[creator].push(offerId);

        LibVaipakam.Offer storage offer = s.offers[offerId];
        _writeOfferFields(offer, creator, offerId, params);

        LibVaipakam.LiquidityStatus principalLiq = OracleFacet(address(this))
            .checkLiquidity(params.lendingAsset);
        LibVaipakam.LiquidityStatus collateralLiq = OracleFacet(address(this))
            .checkLiquidity(params.collateralAsset);
        offer.principalLiquidity = principalLiq;
        offer.collateralLiquidity = collateralLiq;

        if (!params.creatorRiskAndTermsConsent) revert RiskAndTermsConsentRequired();

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

        // ── T-034 — Periodic Interest Payment cadence validation ──────────
        // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
        // Three filters in order:
        //   - Master kill-switch: feature disabled → cadence must be None.
        //   - Filter 0: both sides liquid → otherwise cadence forced to None.
        //   - Filter 1: cadence interval strictly less than duration.
        //   - Filter 2: duration / threshold matrix (mandatory Annual on
        //     >365d loans; finer cadences require principal ≥ threshold).
        _validatePeriodicCadence(params, offer, principalLiq, collateralLiq);

        escrow = getUserEscrow(creator);
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
    ///      Single step now after the Numeraire generalization (B1) architectural
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
    ///      `EscrowFactoryFacet.escrowDepositERC20` (the protocol-wide
    ///      chokepoint) so the `protocolTrackedEscrowBalance` counter
    ///      ticks at every legitimate inflow. NFTs (ERC-721 / ERC-1155)
    ///      bypass the counter — they're tracked per-loan via
    ///      `loan.collateralAsset / tokenId / quantity` references
    ///      rather than fungible balance, so the counter doesn't
    ///      apply to them. The `escrow` argument stays in the
    ///      signature because NFT receivers still target it directly.
    function _pullCreatorAssetsClassic(
        address creator,
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
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowDepositERC20.selector,
                        creator,
                        params.lendingAsset,
                        lenderPull
                    ),
                    EscrowDepositFailed.selector
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC721) {
                IERC721(params.lendingAsset).safeTransferFrom(
                    creator,
                    escrow,
                    params.tokenId
                );
            } else if (params.assetType == LibVaipakam.AssetType.ERC1155) {
                IERC1155(params.lendingAsset).safeTransferFrom(
                    creator,
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
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowDepositERC20.selector,
                            creator,
                            params.collateralAsset,
                            params.collateralAmount
                        ),
                        EscrowDepositFailed.selector
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(params.collateralAsset).safeTransferFrom(
                        creator,
                        escrow,
                        params.collateralTokenId
                    );
                } else if (params.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(params.collateralAsset).safeTransferFrom(
                        creator,
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
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowDepositERC20.selector,
                        creator,
                        params.prepayAsset,
                        totalPrepay
                    ),
                    EscrowDepositFailed.selector
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
        f.amountMax = offer.amountMax;
        f.interestRateBpsMax = offer.interestRateBpsMax;
        f.creatorRiskAndTermsConsent = offer.creatorRiskAndTermsConsent;
        f.allowsPartialRepay = offer.allowsPartialRepay;
        f.periodicInterestCadence = offer.periodicInterestCadence;

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
        offer.creatorRiskAndTermsConsent = params.creatorRiskAndTermsConsent;
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
     * @notice Resolve (creating lazily) a user's per-user escrow proxy.
     * @dev Public Diamond entrypoint, retained on this facet post-split
     *      (Issue #67). The cross-facet wrapper body now lives in
     *      {LibUserEscrow.getOrCreate} so `OfferAcceptFacet` can share it
     *      without re-hosting the selector. Reverts GetUserEscrowFailed
     *      on cross-facet call failure.
     * @param user The user whose escrow to resolve (created lazily).
     * @return proxy The user's escrow proxy address.
     */
    function getUserEscrow(address user) public returns (address proxy) {
        return LibUserEscrow.getOrCreate(user);
    }
}
