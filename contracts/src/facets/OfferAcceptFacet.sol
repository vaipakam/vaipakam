// src/facets/OfferAcceptFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../libraries/LibAcceptTerms.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {RefinanceFacet} from "./RefinanceFacet.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
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
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LoanFacet} from "./LoanFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "./PrecloseFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {LibUserVault} from "../libraries/LibUserVault.sol";

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
    /// @notice T-086 Round-8 (#358) §19.7b — raised when accept is
    ///         attempted against an offer whose parallel-sale already
    ///         filled (Scenario A — buyer-side won the race). Parallel-
    ///         mapping terminal pattern (same shape as `offerCancelled`).
    error OfferConsumedBySale(uint96 offerId);
    /// @notice Reverts when a single address would land on both sides of
    ///         the loan — same-wallet direct-accept of one's own offer
    ///         OR a matchOffers between two offers from the same creator.
    ///         See #194 + the ADR in
    ///         `docs/DesignsAndPlans/SelfTradePreventionADR.md`.
    /// @param party The collapsed address (lender == borrower).
    error SelfTradeForbidden(address party);
    // #195 — GTT / offer-expiry. Raised when `block.timestamp >=
    // offer.expiresAt && offer.expiresAt != 0` (lazy-enforcement gate
    // at every accept / match consumer). Surfaces `(offerId, expiresAt)`
    // so the frontend can render "this offer expired N minutes ago" —
    // and the indexer can mark the offer terminal off-chain even if the
    // storage row is still in place. The matching `MatchError.OfferExpired`
    // classifier in `LibOfferMatch.previewMatch` lets bots short-circuit.
    error OfferExpired(uint256 offerId, uint64 expiresAt);
    // #125 — AON ("All-or-Nothing") fill-mode terminal. Fired from
    // `OfferMatchFacet.matchOffers` when the matcher's would-be
    // matchAmount doesn't fully consume an AON offer, OR when the AON
    // offer already carries `amountFilled > 0` (defensive — AON
    // offers should never admit a prior fill). Surfaces the AON
    // offer's id, the required fill size (`offer.amount`, which equals
    // `amountMax` per the create-time single-value invariant), and the
    // would-be partial size the matcher computed, so a bot's revert
    // decoder can render "offer X is AON; your match would have only
    // filled <provided> of <required>." Declared here (rather than on
    // `OfferMatchFacet`) for ABI continuity with the other match-
    // routed errors that re-raise from this facet's revert vocabulary.
    error AonRequiresFullFill(uint256 offerId, uint256 required, uint256 provided);
    /// @notice T-407-C (#566) Codex P1 — a direct accept was attempted on
    ///         an offer that `matchOffers` has already partially filled.
    ///         Such an offer must be advanced only through the matcher,
    ///         which consumes its remaining capacity and owns the lien
    ///         decrement (see {OfferMatchFacet.matchOffers}).
    error OfferPartiallyFilled(uint256 offerId, uint256 amountFilled);
    // ── #662 — offer-accept term binding (anti-phishing) ───────────────
    /// @notice A field of the signed `AcceptTerms` did not equal the stored
    ///         offer's value (or its role-correct endpoint). `field` is a
    ///         short ASCII tag identifying the first diverging field, so the
    ///         frontend can point the acceptor at exactly what drifted between
    ///         what they signed and what the chain holds.
    error OfferTermsMismatch(bytes32 field);
    /// @notice An illiquid leg's acknowledged-asset identity in the signed
    ///         `AcceptTerms` did not match the leg's actual asset (or a liquid
    ///         leg named a non-zero acknowledged asset). Blocks a clone that
    ///         hardcodes consent but cannot name the specific illiquid asset.
    error IlliquidAssetNotAcknowledged(address leg);
    /// @notice The EIP-712 `AcceptTerms` signature did not verify for
    ///         `terms.acceptor` (ECDSA or ERC-1271).
    error AcceptSignatureInvalid();
    /// @notice `terms.acceptor` was not the account whose funds move on this
    ///         accept (the direct caller, or the resolved signed-offer
    ///         acceptor) — the digest is bound to one account by design.
    error AcceptorMismatch(address signed, address actual);
    /// @notice `block.timestamp` is past `terms.deadline` — the signing window
    ///         for this acceptance has closed.
    error AcceptDeadlineExpired(uint256 deadline);
    /// @notice `terms.nonce` was already consumed by `terms.acceptor` — a
    ///         captured acceptance signature cannot be replayed.
    error AcceptNonceUsed(uint256 nonce);
    // NotOfferCreator inherited from IVaipakamErrors
    // Create-side errors (InvalidOfferType, OfferDurationExceedsCap, the
    // Range Orders Phase 1 errors, GetUserVaultFailed) live on
    // `OfferCreateFacet` / `LibUserVault` post-split (Issue #67).

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
     *        - ERC-20 loan: lender vault → borrower principal transfer;
     *          borrower-side collateral (ERC-20/721/1155) locked into borrower
     *          vault.
     *        - NFT rental (Lender-offer): borrower prepay (principal fee ×
     *          days + `RENTAL_BUFFER_BPS` buffer) pulled into borrower vault;
     *          rental user set on lender vault.
     *        - NFT rental (Borrower-offer): lender's NFT vaulted, rental
     *          user set.
     *      Delegates loan creation to {LoanFacet.initiateLoan} (LTV/HF gates
     *      apply there). Atomically auto-completes any linked
     *      saleOfferToLoanId / offsetOfferToLoanId flow.
     *
     *      Reverts: InvalidOffer, OfferAlreadyAccepted, CountriesNotCompatible,
     *      RiskAndTermsConsentRequired, KYCRequired,
     *      VaultWithdrawFailed, NFTRenterUpdateFailed, LoanInitiationFailed,
     *      OfferAcceptFailed. Emits OfferAccepted.
     * @param offerId The offer ID to accept.
     * @param terms The acceptor's EIP-712-signed `AcceptTerms` (#662). Carries
     *        the single mandatory risk-and-terms consent (`riskAndTermsConsent`
     *        — combined abnormal-market + illiquid-assets fallback terms, latched
     *        into the loan via {Loan.riskAndTermsConsentFromBoth}) AND every
     *        loan-affecting offer field, each bound by equality against the
     *        stored offer before any value moves. A phishing clone cannot
     *        hardcode an opaque `true` because the wallet renders these typed
     *        terms and the contract enforces the match.
     * @param signature ECDSA / ERC-1271 signature over `terms`'s EIP-712 digest;
     *        must recover to `terms.acceptor == msg.sender`.
     * @return loanId The ID of the initiated loan.
     */
    function acceptOffer(
        uint256 offerId,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        // #662 — anti-phishing term binding. Verify the acceptor's EIP-712
        // signature, consume its nonce, and bind EVERY loan-affecting field
        // (plus the acknowledged-illiquid asset identities) against the stored
        // offer BEFORE any value moves. The acceptor here is the direct caller.
        _verifyAndBindAccept(offerId, _directOfferKey(offerId), terms, signature, msg.sender);
        return
            _acceptOffer(
                offerId,
                terms.riskAndTermsConsent,
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
    ///         borrower's collateral is already vaulted at offer-
    ///         create time, and the lender principal flows vault-
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
     *      principal) go through the lender's vault-internal flow and
     *      don't need Permit2 on the acceptor side — call the classic
     *      {acceptOffer} in that case. Reverts {InvalidAssetType} when
     *      no acceptor ERC-20 pull applies.
     *
     * @param offerId                 The offer to accept.
     * @param terms                   The acceptor's EIP-712-signed `AcceptTerms`
     *                                (#662) — carries the single risk-and-terms
     *                                consent + every loan-affecting field bound
     *                                against the stored offer.
     * @param acceptSignature         ECDSA / ERC-1271 signature over `terms`.
     * @param permit                  Signed Permit2 `PermitTransferFrom`.
     * @param permitSignature         65-byte Permit2 ECDSA signature.
     * @return loanId                 The initiated loan's id.
     */
    function acceptOfferWithPermit(
        uint256 offerId,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata acceptSignature,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata permitSignature
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        // Permit2 only covers ERC-20 acceptor pulls. Pre-validate the
        // offer shape so the caller can't sign a payload that never
        // gets honoured.
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.offerType != LibVaipakam.OfferType.Lender) {
            // Borrower-offer accept: acceptor is the lender; their
            // principal flow goes vault-internal. No acceptor pull to
            // Permit2-ify here.
            revert InvalidAssetType();
        }
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            if (offer.collateralAssetType != LibVaipakam.AssetType.ERC20) {
                revert InvalidAssetType();
            }
        }
        // else: NFT rental — prepayAsset is ERC-20 by design, valid target.
        // #662 — bind the signed terms before the Permit2 pull / loan init.
        _verifyAndBindAccept(offerId, _directOfferKey(offerId), terms, acceptSignature, msg.sender);
        return
            _acceptOffer(
                offerId,
                terms.riskAndTermsConsent,
                /*usePermit=*/ true,
                permit,
                permitSignature
            );
    }

    /// @notice Diamond-internal: verify + bind an EIP-712 `AcceptTerms` for the
    ///         signed-offer fill path (`SignedOfferFacet.acceptSignedOffer*`),
    ///         where the offer is materialized in the same tx and the acceptor
    ///         is the injected `signedOfferAcceptor`, not `msg.sender`.
    /// @dev    Gated `msg.sender == address(this)` so only a same-tx cross-facet
    ///         call reaches it. Keeps the field-binding logic in ONE place
    ///         (this facet) rather than duplicating it into SignedOfferFacet.
    /// @param offerId   The materialized offer id.
    /// @param offerKey  The signed-offer EIP-712 digest (NOT keccak(offerId) —
    ///                  no offerId existed at sign time on this path).
    /// @param terms     The acceptor's signed `AcceptTerms`.
    /// @param signature ECDSA / ERC-1271 signature over `terms`.
    /// @param acceptor  The resolved signed-offer acceptor (the funds-mover).
    function verifyAndBindAccept(
        uint256 offerId,
        bytes32 offerKey,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata signature,
        address acceptor
    ) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        _verifyAndBindAccept(offerId, offerKey, terms, signature, acceptor);
    }

    /// @dev The `AcceptTerms.offerKey` an acceptor signs on the DIRECT accept
    ///      paths — `keccak256(abi.encode(offerId))`. The signed-offer fill
    ///      path instead binds the signed-offer digest (no offerId exists at
    ///      sign time), passed explicitly to {verifyAndBindAccept}.
    function _directOfferKey(uint256 offerId) private pure returns (bytes32) {
        return keccak256(abi.encode(offerId));
    }

    /// @dev #662 — the single anti-phishing chokepoint. Verifies the acceptor's
    ///      EIP-712 `AcceptTerms` signature, consumes its replay nonce, then
    ///      binds every loan-affecting field by EQUALITY against the stored
    ///      offer (role-correct endpoints for ERC-20 lender/borrower; `amount`
    ///      for NFT) and validates the acknowledged-illiquid asset identities
    ///      against the on-chain liquidity classification. Reverts before any
    ///      value moves. Pure function of (stored offer, signed terms) — see
    ///      `docs/DesignsAndPlans/OfferAcceptTermBindingDesign.md` §8b.
    function _verifyAndBindAccept(
        uint256 offerId,
        bytes32 offerKey,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata signature,
        address acceptor
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // 1 — signing window.
        if (block.timestamp > terms.deadline) {
            revert AcceptDeadlineExpired(terms.deadline);
        }
        // 2 — bind the digest to the funds-mover (no cross-ERC-1271 replay).
        if (terms.acceptor != acceptor) {
            revert AcceptorMismatch(terms.acceptor, acceptor);
        }
        // 3 — single-use nonce (replay protection).
        if (s.acceptNonceUsed[terms.acceptor][terms.nonce]) {
            revert AcceptNonceUsed(terms.nonce);
        }
        s.acceptNonceUsed[terms.acceptor][terms.nonce] = true;
        // 4 — EIP-712 signature (ECDSA or ERC-1271 via OZ SignatureChecker).
        if (!LibAcceptTerms.verify(terms, signature)) {
            revert AcceptSignatureInvalid();
        }
        // 5 — field-by-field equality against the stored offer.
        _bindTermsToOffer(offerId, offerKey, terms, s);
        // 6 — acknowledged-illiquid asset identities per leg.
        _assertAcknowledgedIlliquid(terms.lendingAsset, terms.acknowledgedIlliquidLendingAsset);
        _assertAcknowledgedIlliquid(terms.collateralAsset, terms.acknowledgedIlliquidCollateralAsset);
    }

    /// @dev Equality-bind every loan-affecting `AcceptTerms` field against the
    ///      stored offer. `amount` / `interestRateBps` bind against the
    ///      ROLE-CORRECT endpoint (ERC-20 lender ⇒ `amountMax` /
    ///      `interestRateBps`; ERC-20 borrower ⇒ `amount` / `interestRateBpsMax`;
    ///      NFT ⇒ `amount` / `interestRateBps` for both — mirrors
    ///      `LoanFacet._bookLoanTerms`). A diverging field reverts
    ///      `OfferTermsMismatch(<tag>)` so the frontend can pinpoint the drift.
    function _bindTermsToOffer(
        uint256 offerId,
        bytes32 offerKey,
        LibAcceptTerms.AcceptTerms calldata t,
        LibVaipakam.Storage storage s
    ) private view {
        LibVaipakam.Offer storage o = s.offers[offerId];
        bool isERC20 = o.assetType == LibVaipakam.AssetType.ERC20;
        bool isLender = o.offerType == LibVaipakam.OfferType.Lender;
        uint256 roleAmount = isERC20 ? (isLender ? o.amountMax : o.amount) : o.amount;
        uint256 roleRate = isERC20
            ? (isLender ? o.interestRateBps : o.interestRateBpsMax)
            : o.interestRateBps;

        if (t.offerKey != offerKey) revert OfferTermsMismatch("offerKey");
        if (t.offerCreator != o.creator) revert OfferTermsMismatch("offerCreator");
        if (t.offerType != uint8(o.offerType)) revert OfferTermsMismatch("offerType");
        if (t.lendingAsset != o.lendingAsset) revert OfferTermsMismatch("lendingAsset");
        if (t.collateralAsset != o.collateralAsset) revert OfferTermsMismatch("collateralAsset");
        if (t.amount != roleAmount) revert OfferTermsMismatch("amount");
        if (t.collateralAmount != o.collateralAmount) revert OfferTermsMismatch("collateralAmount");
        if (t.interestRateBps != roleRate) revert OfferTermsMismatch("interestRateBps");
        if (t.durationDays != o.durationDays) revert OfferTermsMismatch("durationDays");
        if (t.tokenId != o.tokenId) revert OfferTermsMismatch("tokenId");
        if (t.collateralTokenId != o.collateralTokenId) revert OfferTermsMismatch("collateralTokenId");
        if (t.quantity != o.quantity) revert OfferTermsMismatch("quantity");
        if (t.collateralQuantity != o.collateralQuantity) revert OfferTermsMismatch("collateralQuantity");
        if (t.assetType != uint8(o.assetType)) revert OfferTermsMismatch("assetType");
        if (t.collateralAssetType != uint8(o.collateralAssetType)) {
            revert OfferTermsMismatch("collateralAssetType");
        }
        if (t.prepayAsset != o.prepayAsset) revert OfferTermsMismatch("prepayAsset");
        if (t.useFullTermInterest != o.useFullTermInterest) {
            revert OfferTermsMismatch("useFullTermInterest");
        }
        if (t.allowsPartialRepay != o.allowsPartialRepay) {
            revert OfferTermsMismatch("allowsPartialRepay");
        }
        if (t.allowsPrepayListing != o.allowsPrepayListing) {
            revert OfferTermsMismatch("allowsPrepayListing");
        }
        if (t.allowsParallelSale != o.allowsParallelSale) {
            revert OfferTermsMismatch("allowsParallelSale");
        }
        if (t.refinanceTargetLoanId != o.refinanceTargetLoanId) {
            revert OfferTermsMismatch("refinanceTargetLoanId");
        }
        if (t.parallelSaleOrderHash != o.parallelSaleOrderHash) {
            revert OfferTermsMismatch("parallelSaleOrderHash");
        }
        if (t.periodicInterestCadence != uint8(o.periodicInterestCadence)) {
            revert OfferTermsMismatch("periodicInterestCadence");
        }
        // linkedLoanId — the auto-linked sale/offset target (0 for a normal
        // offer). saleOfferToLoanId takes precedence; both 0 ⇒ must bind 0.
        uint256 linked = s.saleOfferToLoanId[offerId];
        if (linked == 0) linked = s.offsetOfferToLoanId[offerId];
        if (t.linkedLoanId != linked) revert OfferTermsMismatch("linkedLoanId");
    }

    /// @dev Validate one leg's acknowledged-illiquid asset identity: an illiquid
    ///      leg MUST name its exact asset; a liquid (or zero) leg MUST name
    ///      `address(0)`. Blocks a clone that hardcodes consent but cannot name
    ///      the specific illiquid asset it is hiding. `address(0)` legs (e.g. no
    ///      collateral on an NFT rental) are treated as "nothing to acknowledge".
    function _assertAcknowledgedIlliquid(address leg, address acknowledged) private view {
        if (leg == address(0)) {
            if (acknowledged != address(0)) revert IlliquidAssetNotAcknowledged(leg);
            return;
        }
        bool illiquid = OracleFacet(address(this)).checkLiquidity(leg) ==
            LibVaipakam.LiquidityStatus.Illiquid;
        if (illiquid) {
            if (acknowledged != leg) revert IlliquidAssetNotAcknowledged(leg);
        } else if (acknowledged != address(0)) {
            revert IlliquidAssetNotAcknowledged(leg);
        }
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

    /// @dev #183 (PR #184 Codex round-1 P1.2) — direct-accept residual-
    ///      collateral refund for borrower offers.
    ///
    ///      When a lender direct-accepts a borrower offer where
    ///      `collateralAmountMax > collateralAmount`, the borrower's
    ///      pre-vaulted excess (`collateralAmountMax - collateralAmount`)
    ///      would otherwise be stranded — the offer terminates with
    ///      `accepted = true` here but matchOffers' dust-close refund
    ///      branch doesn't fire on the direct-accept path. Symmetric
    ///      with the legacy single-fill fallback that lives in
    ///      `OfferMatchFacet.matchOffers` lines 252-277 for the
    ///      `partialFillEnabled = OFF` case.
    ///
    ///      Extracted into a private helper because adding the inline
    ///      block to `_acceptOffer` pushed compilation over viaIR's
    ///      stack-too-deep budget by 3 slots. Storage references are
    ///      essentially pointers (1 slot each), so the helper's calling
    ///      frame stays lean.
    ///
    ///      ERC-20 collateral only — NFT collateral is whole-or-nothing
    ///      (`collateralAmount == collateralAmountMax` always for
    ///      ERC721/ERC1155 by OfferCreateFacet's
    ///      `LenderCollateralRangeNotAllowed` style invariants).
    ///
    ///      No-op on the matchOffers path (`matchOverride.active`) —
    ///      that path runs its own refund + dust-close accounting in
    ///      `OfferMatchFacet.matchOffers`.
    function _refundBorrowerCollateralResidualIfNeeded(
        LibVaipakam.Offer storage offer,
        LibVaipakam.Storage storage s
    ) private {
        if (s.matchOverride.active) return;
        if (offer.offerType != LibVaipakam.OfferType.Borrower) return;
        // PR #187 Codex P2 — also gate on ERC-20 LENDING leg. Borrower
        // NFT rental offers (lendingAsset = NFT) vault prepay-only at
        // create time, not collateral. Even if such an offer is created
        // with `collateralAssetType = ERC20` and
        // `collateralAmountMax > collateralAmount`, the borrower never
        // deposited the excess — the refund call would either underflow
        // the vault's protocolTrackedVaultBalance counter or
        // succeed at withdrawing assets the borrower didn't pre-fund
        // (corrupting another user's vault). Restrict to ERC-20
        // lending offers where the create-time collateral deposit
        // path actually fires.
        if (offer.assetType != LibVaipakam.AssetType.ERC20) return;
        if (offer.collateralAssetType != LibVaipakam.AssetType.ERC20) return;
        if (offer.collateralAmountMax <= offer.collateralAmount) return;
        uint256 collRefund = offer.collateralAmountMax - offer.collateralAmount;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                offer.creator,           // pull from borrower's vault
                offer.collateralAsset,
                offer.creator,           // refund to borrower's wallet
                collRefund
            ),
            VaultWithdrawFailed.selector
        );
    }

    /// @dev #573 — release the borrower offer-collateral lock on a DIRECT
    ///      accept, before `initiateLoan` creates the loan-collateral lien
    ///      on the same `(borrower, collateralAsset, 0)` key (so the two
    ///      don't double-count the aggregate and block the residual
    ///      refund). The match path (`matchOverride.active`) is excluded —
    ///      OfferMatchFacet decrements the lock per fill and releases the
    ///      remainder at dust-close. Gated to the ERC20-borrow +
    ///      ERC20-collateral shape (the only one that pre-vaults a
    ///      fungible collateral lock at create). Extracted so its locals
    ///      stay out of `_acceptOffer`'s stack frame.
    function _releaseBorrowerOfferCollateralLockOnDirectAccept(
        uint256 offerId,
        LibVaipakam.Offer storage offer,
        LibVaipakam.Storage storage s
    ) private {
        if (
            s.matchOverride.active ||
            offer.offerType != LibVaipakam.OfferType.Borrower ||
            offer.assetType != LibVaipakam.AssetType.ERC20 ||
            offer.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) return;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                offerId
            ),
            bytes4(0)
        );
    }

    /// @dev NFT-rental prepay pull. Extracted from `_acceptOffer` to
    ///      keep that function's local count under viaIR's
    ///      stack-too-deep budget after the OfferFacet split.
    ///      Called only when the lender offer's `assetType` is
    ///      ERC721 / ERC1155 (NFT rental) — borrower prepays the
    ///      full term's rental fee + buffer in `prepayAsset` (a
    ///      stablecoin) into their own vault.
    function _pullRentalPrepay(
        LibVaipakam.Offer storage offer,
        address borrower,
        address borrowerVault,
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
                borrowerVault,
                offer.prepayAsset,
                totalPrepay,
                permit,
                signature
            );
            // Permit2 handled the funds movement directly; counter-only
            // sibling records the deposit so the protocolTracked-
            // VaultBalance counter stays in sync.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.recordVaultDepositERC20.selector,
                    borrower,
                    offer.prepayAsset,
                    totalPrepay
                ),
                VaultDepositFailed.selector
            );
        } else {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDepositERC20.selector,
                    borrower,
                    offer.prepayAsset,
                    totalPrepay
                ),
                VaultDepositFailed.selector
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
        // T-407-C (#566) Codex P1 — a partially-filled offer (amountFilled
        // > 0 but not yet dust-closed, so accepted == false) is a
        // matchOffers-managed entity: the matcher consumes its remaining
        // capacity and owns the lien decrement. A DIRECT accept here would
        // size the loan off the offer's FULL ceiling (not the residual)
        // and, after releasing the residual offer-principal lock below,
        // fund a loan larger than the remaining capacity — pulling the
        // creator's unrelated free balance. Reject it; the matcher is the
        // only valid path for a partially-filled offer. (Partial fills
        // exist only under `partialFillEnabled`; single-fill offers go
        // 0 → fully-consumed in one shot and never reach here with
        // amountFilled > 0. The match path sets `matchOverride.active`, so
        // this never fires on a match-routed accept.)
        if (!s.matchOverride.active && offer.amountFilled > 0) {
            revert OfferPartiallyFilled(offerId, offer.amountFilled);
        }
        // T-086 Round-8 (#358) §19.7b — terminal-state gate. If the
        // offer was already consumed by a parallel sale (Scenario A),
        // refuse the accept — the collateral NFT is gone, no loan can
        // be created. Same parallel-mapping pattern as `offerCancelled`
        // (the Offer struct has no `status` field per LibVaipakam:1173).
        if (s.offerConsumedBySale[offerId]) {
            revert OfferConsumedBySale(uint96(offerId));
        }
        // #195 — GTT / offer-expiry. Lazy-enforcement gate: the storage
        // row may still be in place after `expiresAt` (no keeper sweep)
        // but every fill / match path must refuse to bind it to a loan.
        // Routes through `LibVaipakam.isOfferExpired` so the GTC short-
        // circuit lives in one place. Surfaces `(offerId, expiresAt)` so
        // the frontend can render "this offer expired N minutes ago".
        if (LibVaipakam.isOfferExpired(offer)) {
            revert OfferExpired(offerId, offer.expiresAt);
        }

        // #569 decision D-2 (Codex #572 P1 #4, 2026-06-13) — accept-time
        // guard mirroring the offer-create gate. A rental offer created
        // BEFORE `vpfiToken` was configured (or while it was a different
        // address) could carry VPFI as its prepay asset and slip past
        // the create-time gate. Rentals aren't liened (D-1), so a VPFI
        // prepay pool would be drainable via `withdrawVPFIFromVault`.
        // Refuse to bind such an offer into a loan.
        if (
            offer.assetType != LibVaipakam.AssetType.ERC20 &&
            s.vpfiToken != address(0) &&
            offer.prepayAsset == s.vpfiToken
        ) {
            revert VpfiNotAllowedAsRentalPrepay();
        }

        // T-086 Round-8 (#358) §19.7b Scenario B — Codex round-3
        // user-directed redesign: KEEP THE PARALLEL-SALE LISTING LIVE
        // across acceptance.
        //
        // Pre-round-3, this site called `LibPrepayCleanup.clearOfferListing`
        // to tear the listing down on accept. That preserved safety
        // (no double-fill) but dropped the borrower's "borrow-OR-sell"
        // intent — they'd have to manually re-list to keep selling.
        //
        // The new design lets the listing persist:
        //   1. The pre-loan floor now hedges the FULL DURATION's
        //      interest (capped at 1 year) instead of just 1 day, so
        //      the ask price always covers the lender + treasury cut
        //      at the worst-case fill-time accrual.
        //   2. At sale-fill time, `recordOfferSaleProceeds` checks
        //      `offer.accepted`; if true, it splits the proceeds
        //      (lenderLeg + treasuryLeg + remainder to borrower) and
        //      settles the loan atomically (Active → Settled, unlock
        //      borrower NFT, Phase 5 LIF settle).
        //
        // No teardown call here; the listing carries through.

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
        // #396 v0.5 — a signed-offer fill routes through `SignedOfferFacet`,
        // which cross-facet-calls `acceptOfferInternal` (so `msg.sender` is the
        // diamond here). It injects the REAL counterparty into
        // `s.signedOfferAcceptor` for exactly this resolution (set immediately
        // before the call, cleared immediately after). Same shape as the
        // `matchOverride` injection. Precedence: an explicit match override
        // wins, then a signed-offer injection, else the direct caller.
        address acceptor = s.matchOverride.active
            ? s.matchOverride.counterparty
            : (s.signedOfferAcceptor != address(0)
                ? s.signedOfferAcceptor
                : msg.sender);

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

        // T-092 Phase 2b (#506) — re-check the borrower's per-loan
        // refinance caps at accept time. Caps may have been
        // tightened (or disabled) by the borrower between create +
        // accept, or the borrower-NFT may have changed hands —
        // either invalidates the create-time approval. Both at-
        // create and at-accept callers route through the same
        // `LibAutoRefinanceCheck.validate` helper.
        if (offer.refinanceTargetLoanId != 0) {
            uint256 maxRateEffective = offer.interestRateBpsMax == 0
                ? offer.interestRateBps
                : offer.interestRateBpsMax;
            uint256 maxAmountEffective = offer.amountMax == 0
                ? offer.amount
                : offer.amountMax;
            LibAutoRefinanceCheck.validate(
                s,
                offer.refinanceTargetLoanId,
                offer.creator,
                maxRateEffective,
                offer.durationDays,
                offer.lendingAsset,
                offer.collateralAsset,
                offer.assetType,
                offer.collateralAssetType,
                offer.prepayAsset,
                offer.amount,
                maxAmountEffective
            );
        }

        // Per-asset pause: block accepts if either leg has been paused
        // since the offer was created. The offer creator can still cancel
        // and reclaim vaulted assets — cancelOffer is an exit path.
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
        // for the loan being initiated. Precedence:
        //   1. matchOffers in flight → matcher-computed midpoint
        //      stamped in `s.matchOverride.amount`.
        //   2. ERC-20 direct-accept on a Lender offer → lender's
        //      headline max (`offer.amountMax` — what they're providing).
        //   3. ERC-20 direct-accept on a Borrower offer → borrower's
        //      headline floor (`offer.amount` — their min need).
        //   4. NFT rental (assetType ≠ ERC20) → `offer.amount` (daily
        //      rental fee, not a principal headline). PR #187 Codex
        //      P1 — NFT rentals are structurally single-value;
        //      reading `amountMax` here would corrupt the prepay
        //      math in `_pullRentalPrepay` (which computes
        //      `amount × durationDays`). The role-aware mapping
        //      applies only to ERC-20 lending offers.
        // Used by KYC (must gate on real value at risk), the LIF math,
        // the principal transfer, and the OfferAccepted event payload.
        bool _isErc20 = offer.assetType == LibVaipakam.AssetType.ERC20;
        uint256 effectivePrincipal = s.matchOverride.active
            ? s.matchOverride.amount
            : (_isErc20
                ? (offer.offerType == LibVaipakam.OfferType.Lender
                    ? offer.amountMax
                    : offer.amount)
                : offer.amount);

        // Tiered KYC check based on transaction value (per README Section 16)
        uint256 valueNumeraire = _calculateTransactionValueNumeraire(offer, effectivePrincipal);
        if (
            !ProfileFacet(address(this)).meetsKYCRequirement(offer.creator, valueNumeraire) ||
            !ProfileFacet(address(this)).meetsKYCRequirement(acceptor, valueNumeraire)
        ) {
            revert KYCRequired();
        }

        address lenderVault;
        address borrowerVault;
        address lender;
        address borrower;

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            lender = offer.creator;
            borrower = acceptor;
            lenderVault = LibUserVault.getOrCreate(lender);
            borrowerVault = LibUserVault.getOrCreate(borrower);
        } else {
            lender = acceptor;
            borrower = offer.creator;
            lenderVault = LibUserVault.getOrCreate(lender);
            borrowerVault = LibUserVault.getOrCreate(borrower);
        }

        // #194 — self-trade prevention. A user filling their own
        // counter-side offer (whether by direct-accept, or by a bot
        // matching their lender + borrower offers via matchOffers)
        // would: (a) collect the 1% LIF matcher kickback on their own
        // 0.1% fee — net cost is the 99% treasury share but it's free
        // yield on a low-gas chain, (b) pump their share of the daily
        // cross-chain reward denominator with a fake interaction,
        // (c) pollute the indexer's active-loan list with a position
        // they already owned. The check sits AFTER role resolution
        // (so `lender` / `borrower` are concrete) and BEFORE any
        // state mutation, with the address arg surfacing which side
        // collapsed for the revert decoder. Mirrors the
        // `MatchError.SelfTrade` early classifier in
        // `LibOfferMatch.previewMatch` so bots see the error before
        // submitting; the load-bearing revert is here (every match
        // routes through `_acceptOffer` via `acceptOfferInternal`).
        if (lender == borrower) revert SelfTradeForbidden(lender);

        // `effectivePrincipal` was computed earlier (before KYC) so the
        // value is available for KYC, LIF math, principal transfer, and
        // the OfferAccepted event payload below. See #183.
        uint256 vpfiDiscountDeducted;
        if (offer.assetType == LibVaipakam.AssetType.ERC20) {
            // Borrower-offer ERC-20 path: lender is the acceptor and has
            // NOT pre-funded principal at any earlier step (only Lender
            // offers do that, at `createOffer` time via
            // `_pullCreatorAssetsClassic`). Pull `offer.amount` from the
            // lender's wallet into the lender's vault now, through the
            // standard `vaultDepositERC20` chokepoint so the
            // `protocolTrackedVaultBalance` counter ticks. Without this,
            // the subsequent `vaultWithdrawERC20(lender, …)` calls
            // below underflow the counter (Solidity 0.8 `-=` panic).
            //
            // Skip the pull on the matching path
            // (`matchOverride.active`): there the lender funded their
            // SIDE via a Lender offer's `amountMax` pre-vault at
            // create time, and the matched principal is debited from
            // that pool (with `amountFilled` accounting in
            // `LibOfferMatch.executeMatch`). Pulling again from the
            // lender's wallet would be a double-deposit they never
            // approved.
            //
            // Why no public self-deposit chokepoint instead: a
            // standalone `vaultDepositERC20Self(token, amount)` would
            // let any address park funds in vault with the counter
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
                        VaultFactoryFacet.vaultDepositERC20.selector,
                        lender,
                        offer.lendingAsset,
                        offer.amount
                    ),
                    VaultDepositFailed.selector
                );
            }

            // T-407-C (#566) — release the offer-principal lock before
            // the lender's principal leaves their vault below. A DIRECT
            // single-fill accept consumes the lender offer in full
            // (`effectivePrincipal == offer.amountMax`, the entire
            // pre-vaulted principal), so the whole lien is released
            // here. The matching path (`matchOverride.active`) is
            // EXCLUDED: there the per-fill lien decrement / dust-close
            // release is owned by `OfferMatchFacet.matchOffers`, and a
            // full release here would wrongly free a partially-filled
            // lender's still-locked remaining principal. Mirrors the
            // `!s.matchOverride.active` gate on the borrower-path deposit
            // just above. Must precede the treasury / matcher /
            // net-to-borrower withdraws or the vault-withdraw chokepoint
            // would treat the principal as still encumbered and block
            // the lender's own disbursement.
            if (
                offer.offerType == LibVaipakam.OfferType.Lender &&
                !s.matchOverride.active
            ) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                        offerId
                    ),
                    bytes4(0)
                );
            }

            // Default path: deduct the 0.1% Loan Initiation Fee from the
            // lender's vault BEFORE the net is delivered to the borrower
            // (README §6 lines 280, 332). Borrower still owes the full
            // `offer.amount` back — the fee is paid out of the lender's
            // funded principal, not added on top of the debt.
            //
            // VPFI path (Phase 5 / §5.2b): activates when the borrower has
            // enabled the platform-level VPFI-discount consent setting
            // (s.vpfiDiscountConsent[borrower]), the lending asset is
            // liquid, AND the borrower's vault holds ≥ the FULL 0.1%
            // LIF equivalent in VPFI. On success:
            //   - Borrower pays the FULL 0.1% LIF equivalent in VPFI from
            //     vault into Diamond custody (via
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
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
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
                                VaultFactoryFacet.vaultWithdrawERC20.selector,
                                lender,
                                offer.lendingAsset,
                                // Read matcher inline from storage to
                                // keep this function under viaIR's
                                // stack-too-deep budget. #396 v0.5: on a
                                // signed-offer fill `msg.sender` is the
                                // diamond (cross-facet `acceptOfferInternal`),
                                // so fall back to the injected real filler.
                                s.matchOverride.active
                                    ? s.matchOverride.matcher
                                    : (s.signedOfferAcceptor != address(0)
                                        ? s.signedOfferAcceptor
                                        : msg.sender),
                                matcherCut
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                }
            }

            // Transfer net principal to borrower (full amount when the VPFI
            // discount path fired; principal − fee otherwise).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    lender,
                    offer.lendingAsset,
                    borrower,
                    netToBorrower
                ),
                VaultWithdrawFailed.selector
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
                    borrowerVault,
                    usePermit,
                    permit,
                    signature
                );
            } else {
                // Borrower-type NFT offer accepted by lender: vault the lender's NFT.
                // The lender (msg.sender/acceptor) must custody the NFT in their vault
                // for the rental duration, matching the Lender-offer model.
                if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderVault,
                        offer.tokenId
                    );
                } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.lendingAsset).safeTransferFrom(
                        lender,
                        lenderVault,
                        offer.tokenId,
                        offer.quantity,
                        ""
                    );
                }
            }

            // Set renter (borrower as user)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    lender,
                    offer.lendingAsset,
                    offer.tokenId,
                    borrower,
                    uint64(block.timestamp + offer.durationDays * 1 days)
                ),
                NFTRenterUpdateFailed.selector
            );
        }

        // Lock collateral from borrower (already in vault for Borrower offers)
        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // ERC-20 lending: lock collateral based on collateral asset type
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    if (usePermit) {
                        LibPermit2.pull(
                            borrower,
                            borrowerVault,
                            offer.collateralAsset,
                            offer.collateralAmount,
                            permit,
                            signature
                        );
                        // Permit2 already moved funds; counter-only
                        // record so the protocolTrackedVaultBalance
                        // tally stays in sync.
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.recordVaultDepositERC20.selector,
                                borrower,
                                offer.collateralAsset,
                                offer.collateralAmount
                            ),
                            VaultDepositFailed.selector
                        );
                    } else {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultDepositERC20.selector,
                                borrower,
                                offer.collateralAsset,
                                offer.collateralAmount
                            ),
                            VaultDepositFailed.selector
                        );
                    }
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    IERC721(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerVault,
                        offer.collateralTokenId
                    );
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    IERC1155(offer.collateralAsset).safeTransferFrom(
                        borrower,
                        borrowerVault,
                        offer.collateralTokenId,
                        offer.collateralQuantity,
                        ""
                    );
                }
            }
            // ERC721/ERC1155 lender offers: borrower prepay already transferred above
        }

        // #573 — borrower offer-collateral hand-off (extracted to a helper
        // to keep this function's local count under viaIR's stack-too-deep
        // budget, same as `_refundBorrowerCollateralResidualIfNeeded`).
        // On a DIRECT accept it releases the offer-collateral lock in full
        // BEFORE `initiateLoan` creates the loan-collateral lien on the
        // SAME (borrower, collateralAsset, 0) key — otherwise the two
        // double-count the aggregate and the residual-collateral refund
        // below is blocked. The loan lien re-encumbers the backing
        // portion; the unused tail is refunded.
        _releaseBorrowerOfferCollateralLockOnDirectAccept(offerId, offer, s);

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
            : (s.signedOfferAcceptor != address(0)
                ? s.signedOfferAcceptor
                : msg.sender);

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
            // #183 (PR #184 Codex round-1 P1.2) — direct-accept
            // residual-collateral refund for borrower offers. Extracted
            // to `_refundBorrowerCollateralResidualIfNeeded` to keep
            // `_acceptOffer`'s local count under viaIR's stack-too-deep
            // budget — adding the inline block here pushed compilation
            // over by 3 slots.
            _refundBorrowerCollateralResidualIfNeeded(offer, s);
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

            // T-092-H (#549) — atomic accept-and-refinance, DIRECT
            // path. When the accepted offer is a refinance-tagged
            // Borrower offer (`refinanceTargetLoanId != 0`,
            // persisted by `OfferCreateFacet._writeOfferFields`),
            // chain into `RefinanceFacet.refinanceLoanFromAccept`
            // in the SAME tx via the dedicated diamond-internal
            // entry. The chain inherits the outer `acceptOffer`'s
            // `nonReentrant` lock; the inner entry has no
            // `nonReentrant` of its own (Codex round-1 P1 on the
            // closed PR #542 was that nested guards revert).
            //
            // Error bubble: empty fallback selector lets the inner
            // revert payload pass through verbatim — the dapp's
            // `autoLifecycleErrors.ts` decoder already handles the
            // typed errors (`RefinanceCapsRequired`,
            // `SanctionedAddress`, etc.). Wrapping with a synthetic
            // `AtomicRefinanceFailed` was abandoned (Codex round-1
            // P3 — `LibRevert.bubbleOnFailureTyped` only synthesizes
            // on empty revert).
            //
            // Matched-path companion lives in OfferMatchFacet's
            // dust-close branch (see design doc §3.3.2) — runs
            // there because `partialFillEnabled == true` defers the
            // `accepted = true` flip out of this if-block.
            if (
                offer.refinanceTargetLoanId != 0 &&
                offer.offerType == LibVaipakam.OfferType.Borrower
            ) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        RefinanceFacet.refinanceLoanFromAccept.selector,
                        offer.refinanceTargetLoanId,
                        offerId
                    ),
                    bytes4(0)
                );
            }
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
            // #396 v0.5 — inject the real filler ONLY on the signed-offer path
            // (where `msg.sender` is the diamond via cross-facet
            // `acceptOfferInternal`). The matchOffers path keeps emitting
            // `msg.sender` (the matcher/bot) and legacy direct keeps emitting
            // the caller — both unchanged, so indexer semantics don't shift.
            s.signedOfferAcceptor != address(0)
                ? s.signedOfferAcceptor
                : msg.sender,
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
    ///      otherwise) — see Numeraire generalization (b1) release notes.
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

    /// @notice #627 — public view exposing the canonical KYC transaction value
    ///         (`_calculateTransactionValueNumeraire`) so an off-loan caller can
    ///         apply the SAME numeraire valuation the accept path uses.
    /// @dev    Lets the ERC-4626 aggregator adapter screen its real principal's
    ///         KYC at the EXACT value the Diamond would otherwise apply to the
    ///         adapter (the resolved acceptor) — closing the clean-adapter KYC
    ///         bypass without re-deriving (and risking drift from) the oracle
    ///         valuation. Pure read; no state change.
    /// @param  offerId The counterparty (borrower) offer being filled.
    /// @param  lendingAmount The loan principal for this fill (numeraire value
    ///         folds in the offer's liquid collateral, mirroring the accept path).
    /// @return valueNumeraire The transaction value, scaled to 1e18.
    function calculateTransactionValueNumeraire(
        uint256 offerId,
        uint256 lendingAmount
    ) external view returns (uint256 valueNumeraire) {
        return
            _calculateTransactionValueNumeraire(
                LibVaipakam.storageSlot().offers[offerId],
                lendingAmount
            );
    }

    // ═════════════════════════════════════════════════════════════════
    // previewAccept — direct-accept dry-run for the frontend (#196)
    // ═════════════════════════════════════════════════════════════════

    /// @notice Typed revert classifier for `previewAccept`. Mirrors the
    ///         precondition chain in `_acceptOffer` so the frontend can
    ///         distinguish recoverable failures (KYC tier-up unlocks the
    ///         offer; pause lift unblocks; counterparty country shift,
    ///         etc.) from terminal ones (offer already filled, sanctioned
    ///         counterparty, offer expired).
    /// @dev    `OfferExpired` was reserved as a comment-only slot pre-#195
    ///         and is filled by #195 (GTT support). Append-only ordering —
    ///         existing classifiers keep their integer codes so off-chain
    ///         consumers don't shift.
    enum AcceptError {
        None,
        OfferAlreadyAccepted,
        SanctionedAcceptor,
        SanctionedCreator,
        AssetPaused,
        CountriesNotCompatible,
        RiskAndTermsConsentRequired,
        KYCRequired,
        // #195 — `block.timestamp >= offer.expiresAt && offer.expiresAt
        // != 0`. Terminal — the offer cannot be revived. The companion
        // typed revert is `OfferExpired(offerId, expiresAt)` on the
        // accept path; this classifier lets `previewAccept` surface the
        // same condition without reverting so the UI can disable the
        // "Accept" button + render an "expired" badge.
        OfferExpired,
        // T-407-C (#566) Codex P2 — direct accept of a partially-filled
        // offer (`amountFilled > 0`, not yet dust-closed) reverts
        // `OfferPartiallyFilled`; only `matchOffers` may advance it.
        // APPENDED (never inserted) so every existing classifier's uint8
        // value stays stable for off-chain decoders.
        OfferPartiallyFilled
    }

    /// @notice Projection of the loan that would land if the supplied
    ///         acceptor called `acceptOffer(offerId, true)` right now.
    ///         Happy-path fields are populated for recoverable error
    ///         cases too (e.g. `errorCode == KYCRequired`) so the
    ///         frontend can render "tier-up to unlock X principal at
    ///         Y bps" alongside the error.
    ///
    /// @param effectivePrincipal       The role-aware principal the loan
    ///                                  would lock — see `LoanFacet`
    ///                                  loan-init for the lender/borrower
    ///                                  / ERC-20 / NFT-rental mapping.
    /// @param interestRateBps          The role-aware rate the loan would
    ///                                  lock. ERC-20 lender offer → the
    ///                                  lender's floor (`offer.interestRateBps`);
    ///                                  ERC-20 borrower offer → the
    ///                                  borrower's ceiling (`offer.interestRateBpsMax`);
    ///                                  NFT rental → single-value (`offer.interestRateBps`).
    /// @param collateralAmount         Collateral the loan would lock
    ///                                  (`offer.collateralAmount` for
    ///                                  every direct-accept path).
    /// @param lifEstimate              0.1% Loan Initiation Fee the lender
    ///                                  would pay out of principal,
    ///                                  expressed in lending-asset wei.
    ///                                  Zero if the borrower has a live
    ///                                  VPFI discount (tier ≥ 1, consent
    ///                                  flipped, vault holds ≥ the FULL
    ///                                  LIF-equivalent VPFI). NFT rentals
    ///                                  do not charge LIF.
    /// @param collateralResidualRefund For borrower offers with
    ///                                  `collateralAmountMax > collateralAmount`,
    ///                                  the excess pre-vaulted collateral
    ///                                  the borrower gets back at accept.
    ///                                  Zero on lender offers and on
    ///                                  borrower offers without a range.
    /// @param errorCode                `None` on the happy path; the first
    ///                                  failing precondition's classifier
    ///                                  otherwise.
    struct AcceptPreview {
        uint256 effectivePrincipal;
        uint256 interestRateBps;
        uint256 collateralAmount;
        uint256 lifEstimate;
        uint256 collateralResidualRefund;
        AcceptError errorCode;
    }

    /// @notice Contract-side dry-run for `acceptOffer(offerId, true)`.
    ///         The frontend gets the resulting loan shape + a typed
    ///         classifier for the would-be revert in a single
    ///         `eth_call` — no off-chain duplication of the role-aware
    ///         mapping, no 4-RPC client-side computation.
    ///
    /// @dev    Walks the same precondition chain as `_acceptOffer` —
    ///         offer-existence, sanctions, per-asset pause, country
    ///         pair, creator consent, KYC threshold — and returns the
    ///         first failing classifier without reverting. Happy-path
    ///         projection fields are populated unconditionally so a
    ///         recoverable error (`KYCRequired`) still surfaces "this
    ///         offer would land 10k @ 300 bps if you tier-up."
    ///
    ///         Reverts only on `InvalidOffer` (creator == address(0)) —
    ///         consistent with `acceptOffer`'s top-of-function behaviour
    ///         and the right move for a non-existent slot. Every other
    ///         precondition surfaces through `errorCode`.
    ///
    ///         Mirrors the direct-accept role-aware mapping in
    ///         `LoanFacet`'s loan-init (`acceptOffer`-path, NOT the
    ///         `matchOffers` matcher-midpoint path — the matcher route
    ///         already has `previewMatch`). `matchOverride` is ignored
    ///         here even if active mid-tx; a preview call is by
    ///         construction outside any in-flight `matchOffers`.
    ///
    ///         Pure view — safe to call via `staticcall`. No reentrancy
    ///         guard, no pause gate (a paused contract still needs to
    ///         answer preview queries for the explorer / indexer / UI).
    /// @param offerId  Offer being previewed.
    /// @param acceptor Address being projected as the acceptor. The
    ///                  frontend passes `connectedAddress`; the indexer
    ///                  / keeper can pass any candidate counterparty.
    /// @return preview The projection plus the first failing precondition.
    function previewAccept(uint256 offerId, address acceptor)
        external
        view
        returns (AcceptPreview memory preview)
    {
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
        // `offer.assetType == ERC20` in `_acceptOffer`).
        //
        // Mirrors the FULL precondition `tryApplyBorrowerLif` itself
        // checks before pulling VPFI, in execution order:
        //   1. borrower has consent flipped
        //   2. lending asset is liquid (oracle classification)
        //   3. `quote(...).canQuote` — borrower's vault VPFI balance
        //      resolves a tier ≥ 1 + the LIF-equivalent VPFI rate
        //      can be computed (`_feeAssetWeiToVpfi` succeeds)
        //   4. borrower's vault exists (`userVaipakamVaults[borrower] != 0`)
        //   5. vault holds ≥ `vpfiRequired` (the full LIF-equivalent VPFI)
        //
        // Codex round-1 P1 (#196): an earlier draft of this function
        // treated `canQuote` alone as equivalent to "discount will
        // apply" and dropped `vpfiRequired` on the floor. That diverged
        // from execution on the path where the borrower has tier 1+
        // bookkeeping (oracle resolves) but the actual vault holds
        // LESS than the FULL LIF-equivalent — `quote` returned true,
        // `tryApplyBorrowerLif` returned false on the balance check,
        // so execution actually charged LIF in the principal asset
        // while the preview projected zero. The vault-balance check
        // below closes that gap.
        //
        // The borrower address depends on the offer side (lender offer
        // → acceptor; borrower offer → creator), same as the loan-init
        // resolution.
        if (_isErc20) {
            address _borrower = _isLender ? acceptor : offer.creator;
            bool _vpfiDiscountApplies;
            if (
                s.vpfiDiscountConsent[_borrower]
                    && OracleFacet(address(this)).checkLiquidity(
                        offer.lendingAsset
                    ) == LibVaipakam.LiquidityStatus.Liquid
            ) {
                (bool _canQuote, uint256 _vpfiRequired, ) =
                    LibVPFIDiscount.quote(
                        offer.lendingAsset,
                        preview.effectivePrincipal,
                        _borrower
                    );
                if (_canQuote) {
                    address _borrowerVault =
                        s.userVaipakamVaults[_borrower];
                    if (
                        _borrowerVault != address(0)
                            && IERC20(s.vpfiToken).balanceOf(_borrowerVault)
                                >= _vpfiRequired
                    ) {
                        _vpfiDiscountApplies = true;
                    }
                }
            }
            if (!_vpfiDiscountApplies) {
                preview.lifEstimate =
                    (preview.effectivePrincipal *
                        LibVaipakam.cfgLoanInitiationFeeBps()) /
                    LibVaipakam.BASIS_POINTS;
            }
        }

        // ─── Precondition chain (first failure wins) ────────────────
        // Order mirrors `_acceptOffer`. First failing check sets
        // `errorCode`; subsequent checks are short-circuited via the
        // sentinel return below to keep the projection deterministic
        // for the frontend.
        if (offer.accepted) {
            preview.errorCode = AcceptError.OfferAlreadyAccepted;
            return preview;
        }
        // T-407-C (#566) Codex P2 — mirror the direct-accept partial-fill
        // guard so the preview never quotes an accept that would revert.
        // A partially-filled offer (`amountFilled > 0`, accepted == false)
        // must be advanced via `matchOffers`, not `acceptOffer`. Order
        // matches `_acceptOffer` (right after the `accepted` check).
        if (offer.amountFilled > 0) {
            preview.errorCode = AcceptError.OfferPartiallyFilled;
            return preview;
        }
        // #195 — surface the GTT lazy-expiry gate before sanctions /
        // pause / KYC. Order mirrors `_acceptOffer` (which checks
        // expiry right after `accepted`) so the classifier the frontend
        // reads matches the first failure that the real accept call
        // would hit.
        if (LibVaipakam.isOfferExpired(offer)) {
            preview.errorCode = AcceptError.OfferExpired;
            return preview;
        }
        if (LibVaipakam.isSanctionedAddress(acceptor)) {
            preview.errorCode = AcceptError.SanctionedAcceptor;
            return preview;
        }
        if (LibVaipakam.isSanctionedAddress(offer.creator)) {
            preview.errorCode = AcceptError.SanctionedCreator;
            return preview;
        }
        // Per-asset pause check — read storage directly so we don't
        // re-enter the reverting helper (`LibFacet.requireAssetNotPaused`).
        if (
            s.assetPaused[offer.lendingAsset]
                || s.assetPaused[offer.collateralAsset]
        ) {
            preview.errorCode = AcceptError.AssetPaused;
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
                preview.errorCode = AcceptError.CountriesNotCompatible;
                return preview;
            }
        }
        // Defensive creator-consent check. `OfferCreateFacet.createOffer`
        // enforces this at create time, but `_acceptOffer` re-checks
        // defensively against any future code path that bypasses
        // creation enforcement — mirror that here.
        if (!offer.creatorRiskAndTermsConsent) {
            preview.errorCode = AcceptError.RiskAndTermsConsentRequired;
            return preview;
        }
        // KYC threshold check — both sides must clear the tier gate at
        // the projected transaction value.
        {
            uint256 _valueNumeraire = _calculateTransactionValueNumeraire(
                offer,
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
                preview.errorCode = AcceptError.KYCRequired;
                return preview;
            }
        }

        // Happy path: errorCode stays `None`.
    }

}
