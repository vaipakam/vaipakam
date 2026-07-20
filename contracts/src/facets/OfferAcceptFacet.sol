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
import {FeeEntitlementFacet} from "./FeeEntitlementFacet.sol";
import {LibFeeEntitlement} from "../libraries/LibFeeEntitlement.sol";
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
    /// @notice #951 v2 (Codex #959) — the offer was cancelled (its
    ///         `offerCancelled` marker is set, e.g. by a creator cancel or by
    ///         `teardownStaleSaleListing` clearing a stale sale listing). The
    ///         accept path now honors this canonical "dead offer" marker so a
    ///         torn-down sale offer can't originate a loan as a normal offer.
    error OfferCancelled(uint96 offerId);
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
    ///         offer's value (or its role-correct endpoint). `field` is a 1-based
    ///         index identifying the first diverging field, so the frontend can
    ///         point the acceptor at exactly what drifted between what they
    ///         signed and what the chain holds. A `uint8` (not a `bytes32` tag)
    ///         to keep the facet under the EIP-170 size limit. Legend:
    ///         1 offerKey · 2 offerCreator · 3 offerType · 4 lendingAsset ·
    ///         5 collateralAsset · 6 amount · 7 collateralAmount ·
    ///         8 interestRateBps · 9 durationDays · 10 tokenId ·
    ///         11 collateralTokenId · 12 quantity · 13 collateralQuantity ·
    ///         14 assetType · 15 collateralAssetType · 16 prepayAsset ·
    ///         17 useFullTermInterest · 18 allowsPartialRepay ·
    ///         19 allowsPrepayListing · 20 allowsParallelSale ·
    ///         21 refinanceTargetLoanId · 22 parallelSaleOrderHash ·
    ///         23 periodicInterestCadence · 24 linkedLoanId.
    error OfferTermsMismatch(uint8 field);
    // `IlliquidAssetNotAcknowledged(address)` is inherited from IVaipakamErrors
    // (shared with LoanFacet, which enforces it at the bypass site — Codex
    // #724 P1; see _verifyAndBindAccept's note).
    /// @notice The EIP-712 `AcceptTerms` signature did not verify for
    ///         `terms.acceptor` (ECDSA or ERC-1271).
    error AcceptSignatureInvalid();
    /// @notice `terms.acceptor` was not the account whose funds move on this
    ///         accept (the direct caller, or the resolved signed-offer
    ///         acceptor) — the digest is bound to one account by design.
    ///         Parameterless to keep the facet under EIP-170 (the caller holds
    ///         both addresses); same rationale for the two below.
    error AcceptorMismatch();
    /// @notice `block.timestamp` is past `terms.deadline` — the signing window
    ///         for this acceptance has closed.
    error AcceptDeadlineExpired();
    /// @notice `terms.nonce` was already consumed by `terms.acceptor` — a
    ///         captured acceptance signature cannot be replayed.
    error AcceptNonceUsed();
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

    // NOTE: there is intentionally NO on-chain `hashAcceptTerms` digest view.
    // EIP-712 digests are a pure client-side computation — the frontend signs via
    // `signTypedData` (it never needed a view), and tests recover the digest with
    // `LibAcceptTerms.digestFor(terms, diamond)`. Hosting the view here cost this
    // facet bytecode it has no EIP-170 room for once #730 added
    // `AcceptTerms.riskTermsVersion`, so it was removed in favour of the off-chain
    // helper. The signed-offer fill path likewise binds its order hash off-chain.

    /// @dev The `AcceptTerms.offerKey` an acceptor signs on the DIRECT accept
    ///      paths — `keccak256(abi.encode(offerId))`. This is a pure client-side
    ///      computation (the frontend / test signer derive it locally — there's
    ///      no on-chain view, to keep the facet under EIP-170). The signed-offer
    ///      fill path instead binds the signed-offer order hash, passed
    ///      explicitly to {verifyAndBindAccept}.
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
            revert AcceptDeadlineExpired();
        }
        // 2 — bind the digest to the funds-mover (no cross-ERC-1271 replay).
        if (terms.acceptor != acceptor) {
            revert AcceptorMismatch();
        }
        // 3 — single-use nonce (replay protection).
        if (s.acceptNonceUsed[terms.acceptor][terms.nonce]) {
            revert AcceptNonceUsed();
        }
        s.acceptNonceUsed[terms.acceptor][terms.nonce] = true;
        // 4 — EIP-712 signature (ECDSA or ERC-1271 via OZ SignatureChecker).
        if (!LibAcceptTerms.verify(terms, signature)) {
            revert AcceptSignatureInvalid();
        }
        // 5 — field-by-field equality against the stored offer (pure; no
        //     liquidity read, so no TOCTOU).
        _bindTermsToOffer(offerId, offerKey, terms, s);
        // 6 — forward the signed acknowledged-illiquid identities to the LTV/HF
        //     bypass site, which ENFORCES them against the same liquidity reads
        //     that authorise the bypass (Codex #724 P1 — a hostile ERC-20 could
        //     otherwise flip a leg's liquidity between an entry-time check and
        //     the gate). `_acceptOffer` clears this injection. The match path
        //     never sets it (exempt).
        s.acceptAckIlliquidLend = terms.acknowledgedIlliquidLendingAsset;
        s.acceptAckIlliquidColl = terms.acknowledgedIlliquidCollateralAsset;
        s.acceptAckActive = true;
        // #730 — inject the signed risk-terms HASH so the #662⇄#671 ack-
        // substitution gate (`LibRiskAccess.assertAcceptorMayTransact`, which
        // runs in LoanFacet's separate call frame and so can't see this calldata)
        // can require the SIGNED ack to be fresh, not just the vault's tier
        // anchor. Binding the unguessable hash (not the numeric version) stops a
        // UI pre-stamping the next version (Codex #736 r3). Like the address slots
        // above, this is NOT cleared on exit (the gate reads it only when
        // `acceptAckActive` is true, and every accept re-injects it) — saving the
        // high-offset SSTORE the facet can't spare under EIP-170.
        s.acceptAckTermsHash = terms.riskTermsHash;
        // #1347 — inject the acceptor's signed Full VPFI tariff opt-in for the
        // post-mint `chargeFullTariff` (and the pre-mint borrower-LIF +10% fold)
        // to read. Party-scoped: the acceptor authorizes draining `C*` from
        // their OWN vault. Like the ack fields above, read only while
        // `acceptAckActive`, so the keeper-match path (which never sets these)
        // keeps the acceptor's side non-Full. `maxCStar` is MANDATORY whenever
        // `acceptorFull` (rev-15 §3) — fail fast here, symmetric with the creator
        // setter's `FullTariffMaxCStarRequired`, so a malformed signature can't
        // fill as non-Full (any positive `C*` over-max) or, if `C*` rounds to 0,
        // stamp Full with no bound (Codex #1366 r4 P3).
        if (terms.acceptorFull && terms.acceptorMaxCStar == 0) {
            revert FullTariffMaxCStarRequired();
        }
        s.acceptAckAcceptorFull = terms.acceptorFull;
        s.acceptAckAcceptorAllowFullDowngrade = terms.acceptorAllowFullDowngrade;
        s.acceptAckAcceptorMaxCStar = terms.acceptorMaxCStar;
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

        // #951 v2 (Codex #959 bind-to-live) — for a lender-sale vehicle, bind
        // principal / duration / collateral against the LIVE loan instead of the
        // immutable offer snapshot. The snapshot drifts (partial-repay shrinks
        // principal, withdraw/auto-liq shrinks collateral, the term shrinks every
        // block) so no equality-vs-snapshot check converges — the buyer signs the
        // live position and #662's anti-phishing guarantee now protects against
        // loan drift. Bound to IMMUTABLE/DISCRETE facts only, never remaining
        // term: principal `==` live (a repay between view and mine forces a
        // correct re-sign), duration `==` the loan's ORIGINAL immutable
        // `durationDays` (fixed maturity = startTime + durationDays; remaining is
        // derived + shown live, never bound), collateral `>=`-style (a reduction
        // fails the buyer's floor; a harmless top-up only improves the position).
        // Rate stays bound to the seller's offer ask (genuinely immutable there).
        uint256 saleLoanId = s.saleOfferToLoanId[offerId];

        // Field indices match the legend on {OfferTermsMismatch}.
        if (t.offerKey != offerKey) revert OfferTermsMismatch(1);
        if (t.offerCreator != o.creator) revert OfferTermsMismatch(2);
        if (t.offerType != uint8(o.offerType)) revert OfferTermsMismatch(3);
        if (t.lendingAsset != o.lendingAsset) revert OfferTermsMismatch(4);
        if (t.collateralAsset != o.collateralAsset) revert OfferTermsMismatch(5);
        if (saleLoanId != 0) {
            LibVaipakam.Loan storage saleLoan = s.loans[saleLoanId];
            if (t.amount != saleLoan.principal) revert OfferTermsMismatch(6);
            if (saleLoan.collateralAmount < t.collateralAmount) revert OfferTermsMismatch(7);
            if (t.durationDays != saleLoan.durationDays) revert OfferTermsMismatch(9);
        } else {
            if (t.amount != roleAmount) revert OfferTermsMismatch(6);
            if (t.collateralAmount != o.collateralAmount) revert OfferTermsMismatch(7);
            if (t.durationDays != o.durationDays) revert OfferTermsMismatch(9);
        }
        if (t.interestRateBps != roleRate) revert OfferTermsMismatch(8);
        if (t.tokenId != o.tokenId) revert OfferTermsMismatch(10);
        if (t.collateralTokenId != o.collateralTokenId) revert OfferTermsMismatch(11);
        if (t.quantity != o.quantity) revert OfferTermsMismatch(12);
        if (t.collateralQuantity != o.collateralQuantity) revert OfferTermsMismatch(13);
        if (t.assetType != uint8(o.assetType)) revert OfferTermsMismatch(14);
        if (t.collateralAssetType != uint8(o.collateralAssetType)) revert OfferTermsMismatch(15);
        if (t.prepayAsset != o.prepayAsset) revert OfferTermsMismatch(16);
        if (t.useFullTermInterest != o.useFullTermInterest) revert OfferTermsMismatch(17);
        if (t.allowsPartialRepay != o.allowsPartialRepay) revert OfferTermsMismatch(18);
        if (t.allowsPrepayListing != o.allowsPrepayListing) revert OfferTermsMismatch(19);
        if (t.allowsParallelSale != o.allowsParallelSale) revert OfferTermsMismatch(20);
        if (t.refinanceTargetLoanId != o.refinanceTargetLoanId) revert OfferTermsMismatch(21);
        if (t.parallelSaleOrderHash != o.parallelSaleOrderHash) revert OfferTermsMismatch(22);
        if (t.periodicInterestCadence != uint8(o.periodicInterestCadence)) revert OfferTermsMismatch(23);
        // linkedLoanId — the auto-linked sale/offset target (0 for a normal
        // offer). saleOfferToLoanId takes precedence; both 0 ⇒ must bind 0.
        uint256 linked = saleLoanId;
        if (linked == 0) linked = s.offsetOfferToLoanId[offerId];
        if (t.linkedLoanId != linked) revert OfferTermsMismatch(24);
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
        // #1193 (Pass-2 D3) — pull the buffer the offer FUNDED (its create-time
        // snapshot), not live config, so the accept pull matches what
        // loan-init records as `loan.bufferAmount` even across a governance retune.
        uint256 buffer = (prepayAmount * LibVaipakam.effectiveRentalBufferBps(offer))
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
        // #951 v2 (Codex #959) — honor the canonical `offerCancelled` marker.
        // `teardownStaleSaleListing` sets it (and clears `saleOfferToLoanId`) when
        // a listed loan goes terminal; without this the torn-down sale offer,
        // whose `accepted`/`amountFilled`/`consumedBySale` flags are all unset and
        // which hasn't expired, would bind as a NORMAL offer here and could
        // originate a loan. Covers every cancellation path, not just sale
        // teardown.
        if (s.offerCancelled[offerId]) revert OfferCancelled(uint96(offerId));
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

        // #1352 — the borrower's HoldOnly LIF discount applies only on a LIQUID
        // lending asset (illiquid loans pay the full LIF, matching the legacy
        // §6b posture; a reward-eligible origination requires a priceable asset
        // anyway per the redesign). Resolve liquidity here at the accept path's
        // canonical valuation point and gate the discount on it below.
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
        // #951 v2 (Codex #959) — for a lender-sale vehicle the buyer's bind
        // already enforces `t.amount == live saleLoan.principal`
        // (`_bindTermsToOffer`), but the value actually FUNDED must match: source
        // it from the LIVE loan, not the stale offer snapshot. Without this the
        // bind passes on the signed live amount while the charge uses the old
        // offer amount whenever the principal drifted since listing (over/
        // underpay). The bind guarantees the two now agree.
        uint256 _saleLoanId = s.saleOfferToLoanId[offerId];
        uint256 effectivePrincipal = s.matchOverride.active
            ? s.matchOverride.amount
            : (_saleLoanId != 0
                ? s.loans[_saleLoanId].principal
                : (_isErc20
                    ? (offer.offerType == LibVaipakam.OfferType.Lender
                        ? offer.amountMax
                        : offer.amount)
                    : offer.amount));

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
                        // #951 v2 (Codex #959) — pull `effectivePrincipal`, not the
                        // stale `offer.amount`. For a normal Borrower offer these
                        // are identical; for a sale vehicle `effectivePrincipal` is
                        // the LIVE loan principal, so the pull matches the withdraw
                        // below (else the tracked-balance counter underflows).
                        effectivePrincipal
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
            // HoldOnly hybrid LIF (#1352, redesign §F3): a consenting,
            // tier-holding borrower gets their hold-tier discount applied
            // DIRECTLY to the lending-asset LIF at accept — `lifAsset =
            // base × (BPS − d_borrower) / BPS`, `d_borrower` resolved at
            // origination (pinned, so no settle-time top-up gaming). No VPFI
            // is moved and no `vpfiHeld` is taken; the peg-custody VPFI path
            // (tryApplyBorrowerLif → Diamond custody → time-weighted rebate)
            // is retired for new loans. Open custody loans keep settling via
            // settleBorrowerLifProper / forfeitBorrowerLif. The per-party VPFI
            // Full tariff is a separate later card (#1347 PR-5).
            // #951 (Codex #959 round-4) — a lender-sale-vehicle accept is a
            // SECONDARY-MARKET position transfer, not a fresh origination: the
            // underlying loan already paid its 0.1% LIF when it was first
            // initiated. Charging LIF again here would haircut the seller's sale
            // proceeds (or over-charge the buyer) for a fee the position already
            // bore. Skip the whole LIF machinery — no VPFI custody, no fee split
            // — and deliver the full sale principal to the seller. The buyer's
            // real economics settle in `completeLoanSale`. See
            // LenderSaleVehicleRedesign.md.
            bool isSaleVehicleAccept = s.saleOfferToLoanId[offerId] != 0;

            if (isSaleVehicleAccept) {
                // Secondary-market position transfer — deliver the full sale
                // principal to the seller (the underlying loan already paid its
                // LIF at origination; #951).
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        lender,
                        offer.lendingAsset,
                        borrower,
                        effectivePrincipal
                    ),
                    VaultWithdrawFailed.selector
                );
            } else {
                // HoldOnly hybrid borrower LIF (#1352, redesign §F3): charge the
                // consent-gated, hold-tier-discounted lending-asset LIF and
                // deliver the net principal to the borrower. No VPFI is moved
                // and no `vpfiHeld` custody is taken — the peg-custody path
                // (LibVPFIDiscount.tryApplyBorrowerLif) is RETIRED for new
                // loans, so a new loan never sets `vpfiHeld`; open custody-path
                // loans (`vpfiHeld > 0`) still settle via settleBorrowerLifProper
                // / forfeitBorrowerLif (untouched). The per-party VPFI Full
                // tariff is a separate later card (#1347 PR-5). Incidence
                // unchanged: the fee is a borrower cash haircut sourced from the
                // lender's funded principal; borrower debt stays the full
                // `effectivePrincipal`. The whole charge + net delivery runs
                // through a cross-facet call to {chargeBorrowerLifAndDeliver}
                // (an `address(this).call` boundary) so NONE of its locals (the
                // fee, matcherCut/treasuryCut, discount staticcall, net) land in
                // this already-at-budget viaIR frame.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        OfferAcceptFacet.chargeBorrowerLifAndDeliver.selector,
                        offerId,
                        offer.lendingAsset,
                        lender,
                        borrower,
                        effectivePrincipal,
                        lendingAssetLiquidity ==
                            LibVaipakam.LiquidityStatus.Liquid,
                        msg.sender
                    ),
                    VaultWithdrawFailed.selector
                );
            }
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

        // #1347 (M2 PR-5a/5b) — per-party Full VPFI fee-entitlement tariff at
        // origination. ERC-20 originations ONLY: a rental pays no LIF, and a
        // sale-vehicle accept is a secondary-market transfer whose underlying
        // loan already paid its LIF (no fresh tariff — mirrors the LIF skip at
        // the charge site above). The whole resolution + `C*` pulls run in
        // `FeeEntitlementFacet`'s FRESH frame (an `address(this).call` boundary),
        // so none of its locals land in this at-viaIR-budget path — same trust
        // model as `chargeBorrowerLifAndDeliver`. The facet self-reads every Full
        // authorization from the offer (creator) + the transient accept binding
        // (acceptor).
        //
        // Invoke the tariff facet when the master switch is on OR a party
        // presented a Full opt-in (see {_fullTariffShouldRun}). The predicate is
        // in a helper so its storage reads stay OFF this at-viaIR-budget frame.
        if (_fullTariffShouldRun(offerId)) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    FeeEntitlementFacet.chargeFullTariff.selector,
                    offerId,
                    loanId,
                    borrower,
                    lender,
                    effectivePrincipal
                ),
                FeeEntitlementChargeFailed.selector
            );
        }

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

        // #1352 — the peg-custody borrower-LIF origination path is retired for
        // new loans, so nothing sets `vpfiHeld` here any more (HoldOnly charges
        // the discounted LIF in the lending asset at accept; no VPFI custody).
        // The `borrowerLifRebate[loanId].vpfiHeld` write + the
        // `emitDiscountApplied` event were removed with it. Open custody-path
        // loans keep their existing `vpfiHeld` and still settle via
        // settleBorrowerLifProper / forfeitBorrowerLif.

        // Auto-complete linked flows atomically so there is no gap where the
        // live loan could be repaid/defaulted between acceptance and completion.
        {
            LibVaipakam.Storage storage sCheck = LibVaipakam.storageSlot();
            // Lender-sale vehicle (created by createLoanSaleOffer)
            uint256 saleLoanId = sCheck.saleOfferToLoanId[offerId];
            if (saleLoanId != 0) {
                // Use `completeLoanSaleInternal` not `completeLoanSale`: this
                // facet's `acceptOffer` already holds the diamond's `nonReentrant`
                // lock, so a cross-facet call into `completeLoanSale` (also
                // `nonReentrant`) would revert `ReentrancyGuardReentrantCall` and
                // break the atomic accept-then-complete (#951 Codex #959). Same
                // shape as the offset path below. Internal entry is gated on
                // `msg.sender == address(this)`.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EarlyWithdrawalFacet.completeLoanSaleInternal.selector,
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
        // #662 — clear the acked-illiquid injection set in _verifyAndBindAccept.
        // It was already read + enforced at LoanFacet's bypass during
        // initiateLoan above. Clearing the `active` flag is the load-bearing
        // reset: the gate reads `acceptAckActive` FIRST and never touches the
        // address slots when it's false, so a stale address at rest is inert.
        // Clearing the two address slots too would be tidier (Codex #724 r2 P3)
        // but costs ~85 B (high struct-offset SSTOREs) the facet doesn't have
        // under EIP-170 — the flag-only reset is correct and sufficient. A
        // revert anywhere above auto-rolls-back the set; the match path never
        // set it.
        s.acceptAckActive = false;
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
    /// @notice Diamond-internal: the full borrower LIF charge + net delivery
    ///         for a NEW (non-sale) ERC-20 loan (#1352).
    /// @dev    Deliberately an EXTERNAL, `msg.sender == address(this)`-gated
    ///         method invoked by {_acceptOffer} through
    ///         `LibFacet.crossFacetCall` — the `address(this).call` boundary
    ///         runs this entire charge (the HoldOnly discount staticcall + the
    ///         three vault withdraws) in a FRESH stack frame, so none of its
    ///         depth lands in `_acceptOffer` / the permit entry, which sit at
    ///         the viaIR stack-too-deep budget. Same trust model as the
    ///         `vaultWithdrawERC20` cross-facet calls it wraps. Computes the
    ///         HoldOnly-discounted lending-asset LIF (§F3, consent-gated
    ///         hold-tier direct reduction — no VPFI moved), charges it from the
    ///         lender's funded principal split 99/1 treasury/matcher, and
    ///         delivers `principal − fee` to the borrower. Matcher resolves to
    ///         the matchOverride bot / injected signed-offer filler /
    ///         msg.sender — read at the ORIGINAL call's context via the stored
    ///         match/signed-offer slots (this method's own `msg.sender` is the
    ///         diamond).
    /// @param  lendingAsset       The ERC-20 principal asset.
    /// @param  lender             The offer's lender (funds the principal + fee).
    /// @param  borrower           The borrowing party (LIF discount + net recipient).
    /// @param  effectivePrincipal The loan principal in lending-asset wei.
    /// @param originalCaller The ORIGINAL accept caller (`msg.sender` in
    ///        `_acceptOffer`). It is threaded in because this method runs
    ///        behind an `address(this).call`, so its own `msg.sender` is the
    ///        diamond — using that as the direct-path matcher would send the
    ///        1% LIF kickback to the diamond instead of the caller who brought
    ///        the fill on-chain.
    function chargeBorrowerLifAndDeliver(
        uint256 offerId,
        address lendingAsset,
        address lender,
        address borrower,
        uint256 effectivePrincipal,
        bool isLiquid,
        address originalCaller
    ) external {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #1347 — resolve whether the BORROWER's per-party Full opt-in will
        // confirm at this instant (dark ⇒ always false ⇒ byte-identical to the
        // pre-#1347 charge). Party-scoped auth: on a Lender offer the borrower is
        // the acceptor (transient accept binding, gated on `acceptAckActive` so a
        // matcher fill can't inherit a stale opt-in); on a Borrower offer the
        // borrower is the creator (auth on the offer). A confirmed opt-in bumps
        // the own-side LIF discount `+10%` in lockstep with the post-mint `C*`
        // charge — {LibFeeEntitlement.fullOptInConfirmed} is the shared verdict
        // {FeeEntitlementFacet.chargeFullTariff} re-derives against the same
        // (same-tx, unchanged) storage, so the bump is never granted without the
        // tariff being taken.
        LibVaipakam.Offer storage offer = s.offers[offerId];
        bool isLenderOffer = offer.offerType == LibVaipakam.OfferType.Lender;
        bool borrowerFull = LibFeeEntitlement.fullOptInConfirmed(
            borrower,
            isLenderOffer
                ? (s.acceptAckActive && s.acceptAckAcceptorFull)
                : offer.creatorFull,
            isLenderOffer
                ? s.acceptAckAcceptorMaxCStar
                : offer.creatorMaxCStar,
            lendingAsset,
            effectivePrincipal,
            offer.durationDays,
            // Accept-time liquidity — the same value `holdOnlyBorrowerLif` gates
            // the +10% bump on, so the pre-mint confirm agrees with the post-mint
            // charge (Full requires a liquid principal, not just a priceable one).
            isLiquid
        );
        // #1347 (Codex #1366 r5) — snapshot the borrower's PRE-MINT free VPFI
        // (the same balance `fullOptInConfirmed` just gated the +10% bump on) so
        // the post-mint `chargeFullTariff` charges Full against THIS value, not
        // the post-lien-release balance. Runs before the offer-collateral lien
        // release, so a borrower whose VPFI collateral is freed at accept can't
        // have Full charged post-mint without the paired pre-mint discount.
        s.acceptAckBorrowerPreFreeVpfi = LibFeeEntitlement.freeVpfiBalance(borrower);
        uint256 initiationFee = LibVPFIDiscount.holdOnlyBorrowerLif(
            borrower,
            effectivePrincipal,
            isLiquid,
            borrowerFull
        );

        if (initiationFee > 0) {
            uint256 matcherCut = LibOfferMatch.matcherShareOf(initiationFee);
            uint256 treasuryCut = initiationFee - matcherCut;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    lender,
                    lendingAsset,
                    LibFacet.getTreasury(),
                    treasuryCut
                ),
                TreasuryTransferFailed.selector
            );
            LibFacet.recordTreasuryAccrual(lendingAsset, treasuryCut);
            if (matcherCut > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        lender,
                        lendingAsset,
                        s.matchOverride.active
                            ? s.matchOverride.matcher
                            : (s.signedOfferAcceptor != address(0)
                                ? s.signedOfferAcceptor
                                : originalCaller),
                        matcherCut
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        }

        // Deliver the net principal (principal − fee) to the borrower.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                lender,
                lendingAsset,
                borrower,
                effectivePrincipal - initiationFee
            ),
            VaultWithdrawFailed.selector
        );
    }

    /// @dev Whether the post-mint Full VPFI tariff cross-facet call should run
    ///      for `offerId`. Only ERC-20 originations bear a tariff (a rental pays
    ///      no LIF; a sale-vehicle accept already paid its LIF at origination).
    ///      Among those it runs when the master switch is on OR a party presented
    ///      a Full opt-in — the acceptor's (transient, read only while
    ///      `acceptAckActive`, so a matcher fill carries none) or the creator's
    ///      (on the offer). A Full opt-in presented while the switch is off still
    ///      routes so it fails closed / downgrades per the party's signed terms
    ///      (kill-switch-first, rev-15 §4); a plain non-Full accept while dark
    ///      skips the call entirely (nothing to charge, and no routing dependency
    ///      for minimal-cut diamonds). Kept in its own frame so the compound read
    ///      set stays off the at-viaIR-budget `_acceptOffer` path.
    function _fullTariffShouldRun(uint256 offerId)
        private
        view
        returns (bool)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.assetType != LibVaipakam.AssetType.ERC20) return false;
        if (s.saleOfferToLoanId[offerId] != 0) return false;
        return
            LibVaipakam.cfgFeeEntitlementEnabled() ||
            (s.acceptAckActive && s.acceptAckAcceptorFull) ||
            offer.creatorFull;
    }

    /// @dev 1e18-scaled numeraire value of `amount` units of `asset`, or 0 when
    ///      the asset is illiquid (unpriced). Shared by both legs of
    ///      {_calculateTransactionValueNumeraire}; kept as a single private helper
    ///      so the (oracle price + decimals + scale) sequence isn't emitted twice
    ///      — the dedup keeps OfferAcceptFacet under the EIP-170 runtime ceiling
    ///      (#951 Codex #959 round-5). An illiquid NFT-rental leg is worth 0 here,
    ///      matching the prior explicit `+= 0`.
    function _liquidNumeraireValue(address asset, uint256 amount)
        private
        view
        returns (uint256)
    {
        if (
            OracleFacet(address(this)).checkLiquidity(asset)
                != LibVaipakam.LiquidityStatus.Liquid
        ) return 0;
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
            .getAssetPrice(asset);
        uint8 tokenDecimals = IERC20Metadata(asset).decimals();
        return (amount * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
    }

    function _calculateTransactionValueNumeraire(
        LibVaipakam.Offer storage offer,
        uint256 lendingAmount
    ) internal view returns (uint256 valueNumeraire) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Lent asset value if liquid (illiquid / NFT-rental leg ≡ 0).
        valueNumeraire = _liquidNumeraireValue(offer.lendingAsset, lendingAmount);

        // Collateral value if liquid. For lender-sale vehicle offers
        // (collateralAmount == 0) use the live loan's actual collateral amount so
        // KYC is not undercounted.
        uint256 effectiveCollateral = offer.collateralAmount;
        uint256 linkedLoanId = s.saleOfferToLoanId[offer.id];
        if (linkedLoanId != 0 && effectiveCollateral == 0) {
            effectiveCollateral = s.loans[linkedLoanId].collateralAmount;
        }
        valueNumeraire += _liquidNumeraireValue(offer.collateralAsset, effectiveCollateral);
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
        OfferPartiallyFilled,
        // #951 v2 (Codex #959 bind-to-live) — sale-vehicle blockers surfaced by
        // `OfferPreviewFacet.previewAccept` so the UI can disable "Accept"
        // without a revert. `SaleLoanNotActive`: the linked loan repaid /
        // defaulted (or was torn down) since listing, so the position no longer
        // exists. `SaleSelfBuy`: the buyer is the linked loan's CURRENT borrower
        // (resolved via `ownerOf(borrowerTokenId)`), who may not buy their own
        // debt's lender side. Both mirror `LoanFacet.initiateLoan`'s sale-vehicle
        // reverts. APPENDED — existing values stay stable.
        SaleLoanNotActive,
        SaleSelfBuy,
        // #951 v2 (Codex #959) — the offer is cancelled (`offerCancelled` set,
        // e.g. by a stale-sale-listing teardown). Surfaced so the UI disables
        // "Accept" without a revert. APPENDED — prior values stay stable.
        OfferIsCancelled
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

}
