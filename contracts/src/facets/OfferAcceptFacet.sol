// src/facets/OfferAcceptFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
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
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {LoanFacet} from "./LoanFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "./PrecloseFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {LibUserEscrow} from "../libraries/LibUserEscrow.sol";

/**
 * @title OfferAcceptFacet
 * @author Vaipakam Developer Team
 * @notice Acceptance of lending and borrowing offers for the Vaipakam P2P
 *         lending platform — initiates the loan on accept. The creation
 *         half lives in `OfferCreateFacet` — `OfferFacet` was split in
 *         two (Issue #67) for EIP-170 contract-size headroom.
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
contract OfferAcceptFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;
    using Strings for uint256;

    /// @dev `OfferCreated`, the `OfferCreatedFields` struct, and
    ///      `OfferCreatedDetails` moved to `OfferCreateFacet` post-split
    ///      (Issue #67). Indexers filter by signature, so the topic0
    ///      hashes are unchanged.

    /// @notice Emitted when an offer is accepted.
    /// @param offerId            The ID of the accepted offer.
    /// @param acceptor           The address of the user accepting the offer.
    /// @param loanId             The ID of the initiated loan.
    /// @param matchAmount        The per-fill amount consumed by this
    ///        acceptance. Phase 1 single-fill acceptances always consume
    ///        the full `offer.amount`; Phase 2 partial fills will report
    ///        per-acceptance slices.
    /// @param newAmountFilled    Post-accept `s.offers[offerId].amountFilled`.
    /// @param newAccepted        Post-accept `s.offers[offerId].accepted`
    ///        (true once the offer is fully consumed).
    ///        EventSourcingAudit §3.2 — saves the watcher / cache a
    ///        follow-up `getOffer` round-trip.
    /// @custom:event-category state-change/offer-mutation
    event OfferAccepted(
        uint256 indexed offerId,
        address indexed acceptor,
        uint256 loanId,
        uint256 matchAmount,
        uint256 newAmountFilled,
        bool newAccepted
    );

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
    error InvalidOffer();
    error InvalidAssetType();
    error OfferAlreadyAccepted();
    // NotOfferCreator inherited from IVaipakamErrors
    // Create-side errors (InvalidOfferType, OfferDurationExceedsCap, the
    // Range Orders Phase 1 errors, GetUserEscrowFailed) live on
    // `OfferCreateFacet` / `LibUserEscrow` post-split (Issue #67).

    // `CancelCooldownActive` moved to `OfferCancelFacet` along with
    // `cancelOffer` (Range Orders Phase 1 OfferFacet split for
    // EIP-170).

    /**
     * @notice Accepts an existing offer and initiates the loan.
     * @dev Compliance gates (in order): country pair via
     *      {LibVaipakam.canTradeBetween}; liquidity re-check with mutual
     *      illiquid consent; tiered KYC via
     *      {ProfileFacet.meetsKYCRequirement} on the transaction
     *      numeraire-quoted value.
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
     *      RiskAndTermsConsentRequired, KYCRequired,
     *      EscrowWithdrawFailed, NFTRenterUpdateFailed, LoanInitiationFailed,
     *      OfferAcceptFailed. Emits OfferAccepted.
     * @param offerId The offer ID to accept.
     * @param acceptorRiskAndTermsConsent Acceptor's mandatory consent to the
     *        combined abnormal-market + illiquid-assets fallback terms
     *        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
     *        README.md §"Liquidity & Asset Classification"). Required on
     *        every accept regardless of leg liquidity; combined with
     *        offer.creatorRiskAndTermsConsent and latched into the resulting
     *        loan via {Loan.riskAndTermsConsentFromBoth}.
     * @return loanId The ID of the initiated loan.
     */
    function acceptOffer(
        uint256 offerId,
        bool acceptorRiskAndTermsConsent
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        return
            _acceptOffer(
                offerId,
                acceptorRiskAndTermsConsent,
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
    /// @param acceptorRiskAndTermsConsent Always passed as `true` from
    ///                                matchOffers — the lender (the
    ///                                injected counterparty) consented
    ///                                at lender-offer create time.
    /// @return loanId                 Newly initiated loan id.
    function acceptOfferInternal(
        uint256 offerId,
        bool acceptorRiskAndTermsConsent
    ) external returns (uint256 loanId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        return
            _acceptOffer(
                offerId,
                acceptorRiskAndTermsConsent,
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
     * @param acceptorRiskAndTermsConsent Mandatory fallback-terms consent.
     * @param permit                  Signed Permit2 `PermitTransferFrom`.
     * @param signature               65-byte ECDSA signature.
     * @return loanId                 The initiated loan's id.
     */
    function acceptOfferWithPermit(
        uint256 offerId,
        bool acceptorRiskAndTermsConsent,
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
                acceptorRiskAndTermsConsent,
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
            // Permit2 handled the funds movement directly; counter-only
            // sibling records the deposit so the protocolTracked-
            // EscrowBalance counter stays in sync.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.recordEscrowDepositERC20.selector,
                    borrower,
                    offer.prepayAsset,
                    totalPrepay
                ),
                EscrowDepositFailed.selector
            );
        } else {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowDepositERC20.selector,
                    borrower,
                    offer.prepayAsset,
                    totalPrepay
                ),
                EscrowDepositFailed.selector
            );
        }
    }

    function _acceptOffer(
        uint256 offerId,
        bool acceptorRiskAndTermsConsent,
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
        if (!(offer.creatorRiskAndTermsConsent && acceptorRiskAndTermsConsent)) {
            revert RiskAndTermsConsentRequired();
        }

        // #183 (Canonical Limit-Order Phase 2) — effective principal
        // for the loan being initiated. Three sources in precedence:
        //   1. matchOffers in flight → matcher-computed midpoint
        //      stamped in `s.matchOverride.amount`.
        //   2. Direct-accept on a Lender offer → lender's headline
        //      max (`offer.amountMax` — what they're providing).
        //   3. Direct-accept on a Borrower offer → borrower's headline
        //      floor (`offer.amount` — their min need).
        // Used by KYC (must gate on real value at risk), the LIF math,
        // the principal transfer, and the OfferAccepted event payload.
        // Single source of truth prevents the field-semantic drift
        // PR #175's Codex P1 finding warned about. Computed BEFORE the
        // KYC check because KYC value-numeraire depends on it.
        uint256 effectivePrincipal = s.matchOverride.active
            ? s.matchOverride.amount
            : (offer.offerType == LibVaipakam.OfferType.Lender
                ? offer.amountMax
                : offer.amount);

        // Tiered KYC check based on transaction value (per README Section 16)
        uint256 valueNumeraire = _calculateTransactionValueNumeraire(offer, effectivePrincipal);
        if (
            !ProfileFacet(address(this)).meetsKYCRequirement(offer.creator, valueNumeraire) ||
            !ProfileFacet(address(this)).meetsKYCRequirement(acceptor, valueNumeraire)
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
            lenderEscrow = LibUserEscrow.getOrCreate(lender);
            borrowerEscrow = LibUserEscrow.getOrCreate(borrower);
        } else {
            lender = acceptor;
            borrower = offer.creator;
            lenderEscrow = LibUserEscrow.getOrCreate(lender);
            borrowerEscrow = LibUserEscrow.getOrCreate(borrower);
        }
        // `effectivePrincipal` was computed earlier (before KYC) so the
        // value is available for KYC, LIF math, principal transfer, and
        // the OfferAccepted event payload below. See #183.
        uint256 vpfiDiscountDeducted;
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            // Borrower-offer ERC-20 path: lender is the acceptor and has
            // NOT pre-funded principal at any earlier step (only Lender
            // offers do that, at `createOffer` time via
            // `_pullCreatorAssetsClassic`). Pull `offer.amount` from the
            // lender's wallet into the lender's escrow now, through the
            // standard `escrowDepositERC20` chokepoint so the
            // `protocolTrackedEscrowBalance` counter ticks. Without this,
            // the subsequent `escrowWithdrawERC20(lender, …)` calls
            // below underflow the counter (Solidity 0.8 `-=` panic).
            //
            // Skip the pull on the matching path
            // (`matchOverride.active`): there the lender funded their
            // SIDE via a Lender offer's `amountMax` pre-escrow at
            // create time, and the matched principal is debited from
            // that pool (with `amountFilled` accounting in
            // `LibOfferMatch.executeMatch`). Pulling again from the
            // lender's wallet would be a double-deposit they never
            // approved.
            //
            // Why no public self-deposit chokepoint instead: a
            // standalone `escrowDepositERC20Self(token, amount)` would
            // let any address park funds in escrow with the counter
            // ticking but with no protocol-flow context, opening a
            // VPFI-staking-tier-snapshot griefing surface. Keeping the
            // pull bound to `acceptOffer` ensures every counter
            // increment maps 1:1 to a specific protocol action.
            //
            // Lender-offer path is unchanged: the creator pre-funded
            // at create time and the counter is already correct here.
            if (
                offer.offerType == LibVaipakam.OfferType.Borrower
                && !s.matchOverride.active
            ) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowDepositERC20.selector,
                        lender,
                        offer.lendingAsset,
                        offer.amount
                    ),
                    EscrowDepositFailed.selector
                );
            }

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
                    .tryApplyBorrowerLif(offer.lendingAsset, effectivePrincipal, borrower);
            }

            uint256 netToBorrower;
            if (discountApplied) {
                netToBorrower = effectivePrincipal;
            } else {
                uint256 initiationFee = (effectivePrincipal *
                    LibVaipakam.cfgLoanInitiationFeeBps()) /
                    LibVaipakam.BASIS_POINTS;
                netToBorrower = effectivePrincipal - initiationFee;

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
                        // Permit2 already moved funds; counter-only
                        // record so the protocolTrackedEscrowBalance
                        // tally stays in sync.
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                EscrowFactoryFacet.recordEscrowDepositERC20.selector,
                                borrower,
                                offer.collateralAsset,
                                offer.collateralAmount
                            ),
                            EscrowDepositFailed.selector
                        );
                    } else {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                EscrowFactoryFacet.escrowDepositERC20.selector,
                                borrower,
                                offer.collateralAsset,
                                offer.collateralAmount
                            ),
                            EscrowDepositFailed.selector
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
                acceptorRiskAndTermsConsent
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

        // Update offer.
        //
        // Issue #102 — defer the `offer.accepted = true` flip when this
        // is a matchOffers-driven accept against a BORROWER offer and
        // `partialFillEnabled` is on. In that mode, `OfferMatchFacet.matchOffers`
        // computes the borrower's remaining capacity post-match and flips
        // `accepted = true` only on dust-close — symmetric with how the
        // lender side already behaves on `matchOffers`. The legacy
        // single-match `acceptOffer` path (matchOverride NOT active) still
        // flips unconditionally; same for lender offers under any flag
        // state; same for borrower offers when partial-fill is off
        // (Phase 1 single-fill rule preserved as a fallback).
        bool deferAcceptFlip =
            s.matchOverride.active
            && offer.offerType == LibVaipakam.OfferType.Borrower
            && s.protocolCfg.partialFillEnabled;
        if (!deferAcceptFlip) {
            // #183 (Canonical Limit-Order Phase 2) — direct-accept
            // residual-collateral refund for borrower offers (PR #184
            // Codex round-1 P1.2). When a lender direct-accepts a
            // borrower offer where `collateralAmountMax >
            // collateralAmount`, the borrower's pre-escrowed excess
            // (`collateralAmountMax - collateralAmount`) would
            // otherwise be stranded — the offer terminates here
            // (`accepted = true` below) but matchOffers' dust-close
            // refund branch doesn't fire on this path. Symmetric
            // with the legacy single-fill fallback that lives in
            // `OfferMatchFacet.matchOffers` lines 252-277 for the
            // partialFillEnabled = OFF case. ERC-20 collateral only:
            // NFT collateral is whole-or-nothing (collateralAmountMax
            // == collateralAmount always for ERC721/ERC1155 by the
            // OfferCreateFacet `LenderCollateralRangeNotAllowed`-style
            // structural invariants).
            if (
                !s.matchOverride.active
                && offer.offerType == LibVaipakam.OfferType.Borrower
                && offer.collateralAssetType == LibVaipakam.AssetType.ERC20
                && offer.collateralAmountMax > offer.collateralAmount
            ) {
                uint256 collRefund = offer.collateralAmountMax - offer.collateralAmount;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        offer.creator,           // pull from borrower's escrow
                        offer.collateralAsset,
                        offer.creator,           // refund to borrower's wallet
                        collRefund
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
            offer.accepted = true;
            // Codex round-1 P1 — `LibMetricsHooks.onOfferAccepted`
            // mutates `activeOfferIdsList` + `assetPairActiveOfferIds`
            // to REMOVE the offer from the active-discovery indexes.
            // Under partial-fill the borrower offer is STILL active
            // until dust-close, so the hook fire must be deferred to
            // `OfferMatchFacet.matchOffers`' dust-close branch (where
            // it lands alongside the actual `accepted = true` flip).
            // The metrics hook stays tightly coupled to the accept-flip
            // so the two state changes can't drift.
            LibMetricsHooks.onOfferAccepted(offerId);
        }

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
            // Borrower offset offer (created by offsetWithNewOffer).
            // Use `completeOffsetInternal` not `completeOffset`: this
            // facet's `acceptOffer` already holds the diamond's
            // `nonReentrant` lock, so a cross-facet call into
            // `completeOffset` (also `nonReentrant`) would revert
            // ReentrancyGuardReentrantCall and break Option-3
            // settlement entirely. Internal entry is gated on
            // `msg.sender == address(this)`.
            uint256 offsetLoanId = sCheck.offsetOfferToLoanId[offerId];
            if (offsetLoanId != 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        PrecloseFacet.completeOffsetInternal.selector,
                        offsetLoanId
                    ),
                    OfferAcceptFailed.selector
                );
            }
        }

        // Phase 1 acceptOffer is single-fill: the storage `amountFilled`
        // counter is reserved for the partial-fill range-orders code path
        // (gated behind `partialFillEnabled`); it stays 0 in legacy single
        // accepts. The event reports the EFFECTIVE post-accept fill amount,
        // which equals the loan principal once accepted (post-#183 the
        // loan principal IS the role-aware effective principal computed
        // at the top of this function — `amountMax` for lender direct-
        // accept, `amount` for borrower direct-accept, `matchOverride.amount`
        // for the matched path).
        uint256 effFilled = offer.accepted ? effectivePrincipal : offer.amountFilled;
        emit OfferAccepted(
            offerId,
            msg.sender,
            loanId,
            effectivePrincipal,
            effFilled,
            offer.accepted
        );
    }


    // Internal helpers

    // Internal: Calculate transaction value in the active numeraire for KYC (liquid parts only)
    /// @dev Value = (lent amount if liquid * price) + (collateral amount if liquid * price). For NFTs, rental value = amount * durationDays if liquid (but NFTs illiquid, ≡ 0).
    ///      Scaled to 1e18 for threshold comparison. Prices come from
    ///      `OracleFacet.getAssetPrice` which returns numeraire-quoted truth
    ///      (USD by post-deploy default; whatever governance has rotated to
    ///      otherwise) — see Numeraire generalization (B1) release notes.
    ///
    /// @dev #183 (Canonical Limit-Order Phase 2) — `lendingAmount` is
    ///      the actual loan principal (role-aware for direct-accept,
    ///      matcher-midpoint under matchOffers), NOT the raw
    ///      `offer.amount` (which under Phase 2 is the lender's
    ///      `minPartialFillAmount` for lender offers, NOT the lent
    ///      amount). KYC must gate on real value at risk.
    function _calculateTransactionValueNumeraire(
        LibVaipakam.Offer storage offer,
        uint256 lendingAmount
    ) internal view returns (uint256 valueNumeraire) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Lent asset value if liquid
        LibVaipakam.LiquidityStatus lentLiquidity = OracleFacet(address(this))
            .checkLiquidity(offer.lendingAsset);
        if (lentLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                .getAssetPrice(offer.lendingAsset);
            uint8 tokenDecimals = IERC20Metadata(offer.lendingAsset).decimals();
            valueNumeraire += (lendingAmount * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        } else if (offer.assetType != LibVaipakam.AssetType.ERC20) {
            // For NFT rentals: Rental value = amount (fee) * durationDays, but since illiquid, ≡ 0
            valueNumeraire += 0;
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
            valueNumeraire += (effectiveCollateral * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        }
    }

}
