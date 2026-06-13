// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title OfferMutateFacet
 * @author Vaipakam Developer Team
 * @notice #193 — in-place offer modification. Replaces the cancel +
 *         recreate two-tx flow with a single state-mutating call that
 *         changes the offer's range terms without taking the offer
 *         off-book or charging LIF (LIF is a loan-init fee, not an
 *         offer-mutation fee).
 *
 *         Hosted entry points:
 *           - `setOfferAmount(offerId, newAmount, newAmountMax)` —
 *             principal range. Lender ERC-20 path pulls / refunds the
 *             delta in `lendingAsset`. Borrower NFT-rental path pulls /
 *             refunds the prepay delta in `prepayAsset`. Other paths
 *             update storage without vault movement (no creator-side
 *             escrow is involved on those offer shapes).
 *           - `setOfferRate(offerId, newRateBps, newRateBpsMax)` —
 *             rate range. Never moves vaulted funds.
 *           - `setOfferCollateral(offerId, newCollateralAmount,
 *             newCollateralAmountMax)` — collateral range. Borrower
 *             ERC-20 path pulls / refunds the delta in `collateralAsset`.
 *             Other paths update storage without vault movement.
 *           - `modifyOffer(offerId, OfferModifyParams)` — combined
 *             atomic helper. Runs the union of invariants and the
 *             union of deltas, emits a single `OfferModified` event.
 *
 *         Invariants enforced on every entry point:
 *           - msg.sender == offer.creator (`NotOfferCreator`).
 *           - !offer.accepted (`OfferAlreadyAccepted`).
 *           - Range invariants identical to {OfferCreateFacet} so the
 *             post-mutation offer satisfies the same shape any
 *             createOffer call would have to satisfy:
 *               * amount > 0, amountMax > 0, amountMax >= amount.
 *               * interestRateBpsMax >= interestRateBps,
 *                 interestRateBpsMax <= MAX_INTEREST_BPS.
 *               * collateralAmount > 0, collateralAmountMax > 0,
 *                 collateralAmountMax >= collateralAmount.
 *               * Lender single-value collateral:
 *                 collateralAmountMax == collateralAmount.
 *           - Partial-fill bound: amountMax >= amountFilled and
 *             collateralAmountMax >= collateralAmountFilled (the
 *             portion already committed to live loans cannot be
 *             shrunk away — would orphan collateral backing real
 *             obligations).
 *           - Per-asset pause + sanctions screening on the creator.
 *
 *         Carved out into its own facet (vs. extending OfferCreateFacet)
 *         to keep the create-time surface tight under EIP-170 review
 *         and to mirror the OfferCancelFacet / OfferMatchFacet
 *         precedent of one facet per lifecycle concern.
 */
contract OfferMutateFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    // ── Events ──────────────────────────────────────────────────────

    /// @notice #193 — emitted on every offer-state mutation, whether
    ///         from one of the per-field setters or from the combined
    ///         `modifyOffer`. Carries the full post-mutation snapshot
    ///         of every field the modify surface can touch, so indexers
    ///         can update their stored offer row from a single event
    ///         without a follow-up `getOffer` view-call.
    /// @dev    The "before" snapshot is intentionally omitted — it's
    ///         recoverable from the indexer's prior `OfferCreated` /
    ///         `OfferModified` row. Keeping the payload to a single
    ///         post-image keeps the event under viaIR's emit-site
    ///         stack budget and the calldata cheap.
    /// @custom:event-category state-change/offer-mutation
    event OfferModified(
        uint256 indexed offerId,
        address indexed creator,
        uint256 amount,
        uint256 amountMax,
        uint256 interestRateBps,
        uint256 interestRateBpsMax,
        uint256 collateralAmount,
        uint256 collateralAmountMax
    );

    // ── Errors ──────────────────────────────────────────────────────

    /// Re-declared locally for ABI continuity with the other lifecycle
    /// facets (`OfferAcceptFacet`, `OfferCancelFacet`) that emit the
    /// same selector. Mutations are blocked on already-accepted offers
    /// for the same reason cancellations are: the offer's terms are
    /// load-bearing on the spawned loan, and post-hoc edits would
    /// silently change what the borrower agreed to.
    error OfferAlreadyAccepted();

    /// `offers[offerId].creator == address(0)` — the storage slot was
    /// never written or was cleared by a prior cancel. Re-declared
    /// locally for ABI continuity with `OfferAcceptFacet` /
    /// `LoanFacet` / `ProfileFacet`, all of which emit the same
    /// selector for "offer does not exist."
    error InvalidOffer();

    /// `setOfferCollateral` called on an offer shape where collateral
    /// is not a creator-side concept (today: borrower NFT-rental
    /// offers, which vault prepay in `prepayAsset` rather than
    /// collateral in `collateralAsset`). Allowing storage writes
    /// without vault movement on that shape would create a divergence
    /// between the offer's claimed collateralAmount and whatever the
    /// matching path would actually require, so we reject loud.
    error CollateralMutationUnsupportedForShape();

    /// `setOfferAmount` would set `amountMax` below `amountFilled`, or
    /// `setOfferCollateral` would set `collateralAmountMax` below
    /// `collateralAmountFilled`. The portion already committed to live
    /// loans (partial fills) cannot be shrunk away — those loans
    /// reference this offer for their terms; collapsing the cap below
    /// what's already filled would orphan real obligations. Surfaces
    /// `(provided, alreadyFilled)` so the UI can render the floor.
    error ModifyBelowFilledFloor(uint256 provided, uint256 alreadyFilled);

    // ── Constructors / modifiers inherited from
    //    DiamondReentrancyGuard, DiamondPausable. ────────────────────

    // ════════════════════════════════════════════════════════════════
    // Public entry points
    // ════════════════════════════════════════════════════════════════

    /**
     * @notice Update the principal range (`amount` floor + `amountMax`
     *         ceiling) on an unaccepted offer the caller created.
     * @dev    Reverts: NotOfferCreator, OfferAlreadyAccepted,
     *         AmountMustBePositive, AmountMaxMustBePositive,
     *         InvalidAmountRange, ModifyBelowFilledFloor,
     *         SanctionedAddress, plus per-asset pause reverts.
     * @param  offerId       Offer to modify.
     * @param  newAmount     New floor of the principal range.
     * @param  newAmountMax  New ceiling. Must be >= `amountFilled`.
     */
    function setOfferAmount(
        uint256 offerId,
        uint256 newAmount,
        uint256 newAmountMax
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        _assertMutableBy(offer);

        // Snapshot BOTH old values before the storage write — the
        // borrower NFT-rental delta path needs `oldAmount` (the prepay
        // formula's load-bearing input) and the lender ERC-20 delta
        // path needs `oldAmountMax`. Reading these after the writes
        // below would return the new values.
        uint256 oldAmount = offer.amount;
        uint256 oldAmountMax = offer.amountMax;
        _assertAmountInvariants(newAmount, newAmountMax, offer.amountFilled);
        // Codex round-3 P2 — re-validate the T-034 cadence threshold
        // against the NEW amount. createOffer rejects (amount, cadence)
        // pairs that violate the principal-vs-threshold rule; modify
        // must enforce the same so a creator can't post above the
        // threshold with a finer cadence and then shrink amount below
        // it while keeping the finer cadence.
        _revalidatePeriodicCadenceForAmount(offer, newAmount);

        offer.amount = newAmount;
        offer.amountMax = newAmountMax;

        _settleAmountDelta(offerId, offer, oldAmount, oldAmountMax, newAmount, newAmountMax);

        _emitModified(offerId, offer);
    }

    /**
     * @notice Update the interest-rate range (`interestRateBps` floor +
     *         `interestRateBpsMax` ceiling) on an unaccepted offer the
     *         caller created.
     * @dev    Never moves vaulted funds — rate is metadata, not an
     *         escrow-pulled quantity. Reverts: NotOfferCreator,
     *         OfferAlreadyAccepted, InvalidRateRange,
     *         InterestRateAboveCeiling, SanctionedAddress, plus
     *         per-asset pause reverts.
     */
    function setOfferRate(
        uint256 offerId,
        uint256 newRateBps,
        uint256 newRateBpsMax
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        _assertMutableBy(offer);
        _assertRateInvariants(newRateBps, newRateBpsMax);

        offer.interestRateBps = newRateBps;
        offer.interestRateBpsMax = newRateBpsMax;

        _emitModified(offerId, offer);
    }

    /**
     * @notice Update the collateral range (`collateralAmount` floor +
     *         `collateralAmountMax` ceiling) on an unaccepted offer
     *         the caller created.
     * @dev    Reverts: NotOfferCreator, OfferAlreadyAccepted,
     *         CollateralMustBePositive, CollateralAmountMaxMustBePositive,
     *         InvalidCollateralAmountRange, LenderCollateralRangeNotAllowed,
     *         CollateralMutationUnsupportedForShape, ModifyBelowFilledFloor,
     *         SanctionedAddress, plus per-asset pause reverts.
     *
     *         Borrower ERC-20 offers vault `collateralAmountMax` in
     *         `collateralAsset` at create — this path pulls / refunds
     *         the delta. Other shapes (lender ERC-20, lender NFT
     *         rental) keep storage in sync with no vault movement;
     *         borrower NFT-rental reverts `CollateralMutationUnsupportedForShape`
     *         because that shape pre-vaults prepay (in `prepayAsset`)
     *         rather than collateral.
     */
    function setOfferCollateral(
        uint256 offerId,
        uint256 newCollateralAmount,
        uint256 newCollateralAmountMax
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        _assertMutableBy(offer);

        uint256 oldCollateralAmountMax = offer.collateralAmountMax;
        _assertCollateralInvariants(
            offer,
            newCollateralAmount,
            newCollateralAmountMax
        );

        offer.collateralAmount = newCollateralAmount;
        offer.collateralAmountMax = newCollateralAmountMax;

        _settleCollateralDelta(
            offerId,
            offer,
            oldCollateralAmountMax,
            newCollateralAmountMax
        );

        _emitModified(offerId, offer);
    }

    /**
     * @notice Atomic combined modify — change any subset of the three
     *         field clusters in a single call. Carries one
     *         `OfferModified` event with the post-image of all six
     *         fields, so indexers see a single mutation instead of
     *         three.
     * @dev    Caller supplies the existing value for fields they
     *         don't intend to change (the frontend reads `getOffer`
     *         first anyway). Validates the union of per-setter
     *         invariants and settles the union of deltas. Atomic —
     *         either every change lands, or none do (the whole tx
     *         reverts on the first violation).
     */
    function modifyOffer(
        uint256 offerId,
        LibVaipakam.OfferModifyParams calldata params
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        _assertMutableBy(offer);

        // Snapshot every old value before writes — the delta helpers
        // and the unchanged-field short-circuits below need pre-mutation
        // reads (storage is about to change).
        uint256 oldAmount = offer.amount;
        uint256 oldAmountMax = offer.amountMax;
        uint256 oldRateBps = offer.interestRateBps;
        uint256 oldRateBpsMax = offer.interestRateBpsMax;
        uint256 oldCollateralAmount = offer.collateralAmount;
        uint256 oldCollateralAmountMax = offer.collateralAmountMax;

        // #193 — per-cluster idempotency. Each cluster (amount, rate,
        // collateral) is only validated + settled when the caller is
        // ACTUALLY changing that cluster's values. Skipping unchanged
        // clusters keeps `modifyOffer` usable on offer shapes where
        // one cluster is structurally non-mutable — borrower NFT-
        // rental can call `modifyOffer` to change amount + rate
        // without tripping `CollateralMutationUnsupportedForShape`,
        // and a lender shape with zero-valued collateral (legacy
        // shapes that don't satisfy today's `>0` invariant) can
        // still update amount + rate. The trade-off: a caller who
        // wants to set unchanged-but-zero collateral on a fresh
        // mutate call must use `setOfferCollateral` directly; modify
        // treats "supplied == existing" as "leave this cluster alone."

        bool amountChanged =
            params.amount != oldAmount || params.amountMax != oldAmountMax;
        bool rateChanged =
            params.interestRateBps != oldRateBps
            || params.interestRateBpsMax != oldRateBpsMax;
        bool collateralChanged =
            params.collateralAmount != oldCollateralAmount
            || params.collateralAmountMax != oldCollateralAmountMax;

        if (amountChanged) {
            _assertAmountInvariants(
                params.amount,
                params.amountMax,
                offer.amountFilled
            );
            // Codex round-3 P2 — same revalidation hook as
            // `setOfferAmount`; the new amount must still satisfy the
            // (amount, cadence) compatibility rule createOffer enforces.
            _revalidatePeriodicCadenceForAmount(offer, params.amount);
        }
        if (rateChanged) {
            _assertRateInvariants(
                params.interestRateBps,
                params.interestRateBpsMax
            );
        }
        if (collateralChanged) {
            _assertCollateralInvariants(
                offer,
                params.collateralAmount,
                params.collateralAmountMax
            );
        }

        if (amountChanged) {
            offer.amount = params.amount;
            offer.amountMax = params.amountMax;
        }
        if (rateChanged) {
            offer.interestRateBps = params.interestRateBps;
            offer.interestRateBpsMax = params.interestRateBpsMax;
        }
        if (collateralChanged) {
            offer.collateralAmount = params.collateralAmount;
            offer.collateralAmountMax = params.collateralAmountMax;
        }

        if (amountChanged) {
            _settleAmountDelta(
                offerId,
                offer,
                oldAmount,
                oldAmountMax,
                params.amount,
                params.amountMax
            );
        }
        if (collateralChanged) {
            _settleCollateralDelta(
                offerId,
                offer,
                oldCollateralAmountMax,
                params.collateralAmountMax
            );
        }

        _emitModified(offerId, offer);
    }

    // ════════════════════════════════════════════════════════════════
    // Internal helpers
    // ════════════════════════════════════════════════════════════════

    /// @dev Common pre-mutation gate: caller must own the offer, the
    ///      offer must not be accepted, neither leg may be paused, and
    ///      the caller's address must not be sanctioned. Sanctions
    ///      screening fires here (and not in the per-setter entry)
    ///      because every mutation either moves the creator's vaulted
    ///      assets (delta path) or changes the terms a future match
    ///      would land at — both behaviours are "creator initiates a
    ///      protocol state change," which is the Tier-1 boundary in
    ///      the sanctions policy.
    function _assertMutableBy(LibVaipakam.Offer storage offer) private view {
        if (offer.creator == address(0)) revert InvalidOffer();
        LibAuth.requireOfferCreator(offer);
        if (offer.accepted) revert OfferAlreadyAccepted();
        // Per-asset pause: a paused leg blocks every mutation including
        // pure-storage rate changes, because resuming after a pause
        // should never surface an offer the operator wouldn't have
        // approved at resume-time.
        LibFacet.requireAssetNotPaused(offer.lendingAsset);
        LibFacet.requireAssetNotPaused(offer.collateralAsset);
        // Sanctions: catches the case where a creator was clean when
        // they posted the offer but got flagged before modifying it.
        if (LibVaipakam.isSanctionedAddress(msg.sender)) {
            revert ProfileFacet.SanctionedAddress(msg.sender);
        }
        // T-086 Round-8 (#358) §19.6 round-3.4 — parallel-sale lock.
        // When an offer has a LIVE parallel-sale Seaport listing, any
        // mutation of the 5 load-bearing fields (amount,
        // interestRateBps, collateralAsset, collateralTokenId,
        // expiresAt — all of which feed the canonical Seaport order
        // hash via OfferContext + Offer struct fields) would
        // invalidate the live order's hash invariant and let a buyer
        // race a stale-priced fill. Every mutator on this facet
        // touches at least one of those 5 fields, so the lock is
        // applied universally here. Borrower MUST call
        // `releaseParallelSaleLock(offerId)` first to non-destructively
        // unwind, then re-post after the mutation.
        if (offer.parallelSaleOrderHash != bytes32(0)) {
            revert OfferLockedByParallelSale();
        }
        // Codex round-6 P2 #5 — after a Scenario A parallel sale,
        // `markOfferConsumedBySale` clears `offer.parallelSaleOrderHash`
        // via the cleanup helper, so the lock check above no longer
        // blocks. But the offer is now in a terminal state (collateral
        // is gone in the Seaport sale, proceeds credited to borrower
        // vault). Mutating it would emit fresh `OfferModified` events
        // and let the creator change terms for an offer whose
        // collateral no longer exists. Block all mutations on consumed
        // offers — same posture as the existing `accepted` block
        // above.
        uint256 offerId = offer.id;
        if (
            offerId != 0 &&
            LibVaipakam.storageSlot().offerConsumedBySale[offerId]
        ) revert OfferAlreadyConsumedBySaleMutate();
    }

    /// @notice Codex round-6 P2 #5 — raised when a creator attempts
    ///         to mutate an offer whose Scenario A parallel sale has
    ///         already filled. Mirrors OfferAlreadyAccepted's
    ///         posture: the offer is terminal, mutation makes no
    ///         sense.
    error OfferAlreadyConsumedBySaleMutate();

    /// @notice T-086 Round-8 (#358) §19.6 — raised by every mutator
    ///         when a live parallel-sale Seaport listing is bound to
    ///         the offer. Borrower must release the lock first.
    error OfferLockedByParallelSale();

    /// @dev Reuses the OfferCreateFacet revert types so the modify
    ///      surface and the create surface speak the same revert ABI.
    function _assertAmountInvariants(
        uint256 newAmount,
        uint256 newAmountMax,
        uint256 alreadyFilled
    ) private pure {
        if (newAmount == 0) revert OfferCreateFacet.AmountMustBePositive();
        if (newAmountMax == 0) revert OfferCreateFacet.AmountMaxMustBePositive();
        if (newAmountMax < newAmount) revert OfferCreateFacet.InvalidAmountRange();
        // Modify-specific bound: the new ceiling cannot fall below the
        // portion already committed to live loans. Without this, a
        // creator could shrink amountMax to amountFilled-1 and the
        // remaining open-loan exposure would exceed the offer's
        // stated cap — a divergence the matching path's
        // `lenderRemaining = amountMax - amountFilled` computation
        // would underflow on.
        if (newAmountMax < alreadyFilled) {
            revert ModifyBelowFilledFloor(newAmountMax, alreadyFilled);
        }
    }

    function _assertRateInvariants(
        uint256 newRateBps,
        uint256 newRateBpsMax
    ) private pure {
        // Mirrors `_writeOfferPrincipalFields` — rate may legitimately
        // be zero on both ends (NFT-rental APR has no economic
        // meaning; zero-interest ERC-20 loans are a real shape too).
        if (newRateBpsMax < newRateBps) revert OfferCreateFacet.InvalidRateRange();
        if (newRateBpsMax > LibVaipakam.MAX_INTEREST_BPS) {
            revert OfferCreateFacet.InterestRateAboveCeiling();
        }
    }

    /// @dev Borrower NFT-rental offers have no creator-side collateral
    ///      escrow (the prepay sits in `prepayAsset` and travels with
    ///      `setOfferAmount`, not this setter), so this path must
    ///      reject mutations rather than let storage drift away from
    ///      the actual escrow.
    function _assertCollateralInvariants(
        LibVaipakam.Offer storage offer,
        uint256 newCollateralAmount,
        uint256 newCollateralAmountMax
    ) private view {
        if (
            offer.offerType == LibVaipakam.OfferType.Borrower
            && offer.assetType != LibVaipakam.AssetType.ERC20
        ) {
            revert CollateralMutationUnsupportedForShape();
        }

        // Codex round-2 P2 — mirror `_writeOfferCollateralFields`'s
        // strict-collateral rule: only enforce `collateralAmount > 0`
        // and `collateralAmountMax > 0` for true ERC-20 LOANS (both
        // legs ERC-20) AND not the lender-sale-vehicle "both zero"
        // pattern. Three create-time exceptions get the same pass:
        //   1. NFT collateral (`collateralAssetType` ERC-721 / ERC-1155):
        //      lock is by `collateralTokenId` / quantity, not an amount.
        //   2. NFT-rental offers (`assetType` ERC-721 / ERC-1155):
        //      the rental fee × duration IS the commitment; collateral
        //      is optional.
        //   3. Lender sale-vehicle / no-collateral lender offers
        //      shipped as `collateralAmount == 0 == collateralAmountMax`
        //      (BOTH zero, explicit). The actual collateral comes from
        //      a linked loan via `s.saleOfferToLoanId[offerId]`.
        // Mixed shapes (one zero, the other positive) still revert.
        bool enforceStrictCollateral =
            offer.assetType == LibVaipakam.AssetType.ERC20
            && offer.collateralAssetType == LibVaipakam.AssetType.ERC20
            && !(newCollateralAmount == 0 && newCollateralAmountMax == 0);
        if (enforceStrictCollateral) {
            if (newCollateralAmount == 0) {
                revert OfferCreateFacet.CollateralMustBePositive();
            }
            if (newCollateralAmountMax == 0) {
                revert OfferCreateFacet.CollateralAmountMaxMustBePositive();
            }
        }
        if (newCollateralAmountMax < newCollateralAmount) {
            revert OfferCreateFacet.InvalidCollateralAmountRange();
        }

        // Lender-side single-value invariant: a lender's
        // `collateralAmount` already expresses their derived
        // requirement at `amountMax`; a max wouldn't add meaning.
        // Mirrors `_writeOfferCollateralFields` so the post-mutation
        // shape passes the same check `createOffer` enforces.
        if (
            offer.offerType == LibVaipakam.OfferType.Lender
            && newCollateralAmountMax != newCollateralAmount
        ) {
            revert OfferCreateFacet.LenderCollateralRangeNotAllowed();
        }

        // Modify-specific bound on the partial-filled portion (only
        // borrower offers track collateralAmountFilled today). Same
        // rationale as the amount-floor: collapsing the cap below
        // what's backing live loans would orphan real obligations.
        if (
            offer.offerType == LibVaipakam.OfferType.Borrower
            && newCollateralAmountMax < offer.collateralAmountFilled
        ) {
            revert ModifyBelowFilledFloor(
                newCollateralAmountMax,
                offer.collateralAmountFilled
            );
        }
    }

    /// @dev Move the principal-side delta in or out of the creator's
    ///      vault. Only fires when the offer's pre-vault shape
    ///      actually depends on `amountMax` (lender ERC-20 path) OR
    ///      on `amount` via the derived prepay (borrower NFT-rental
    ///      path); other shapes don't pre-vault anything keyed on
    ///      either field, so a no-op is correct.
    /// @param  offer          Storage pointer.
    /// @param  oldAmount      Pre-mutation `amount` (load-bearing for
    ///                        the borrower-NFT-rental prepay delta).
    /// @param  oldAmountMax   Pre-mutation `amountMax` (load-bearing
    ///                        for the lender-ERC-20 principal delta).
    /// @param  newAmount      Post-mutation `amount`.
    /// @param  newAmountMax   Post-mutation `amountMax`.
    function _settleAmountDelta(
        uint256 offerId,
        LibVaipakam.Offer storage offer,
        uint256 oldAmount,
        uint256 oldAmountMax,
        uint256 newAmount,
        uint256 newAmountMax
    ) private {
        if (
            offer.offerType == LibVaipakam.OfferType.Lender
            && offer.assetType == LibVaipakam.AssetType.ERC20
        ) {
            // Lender ERC-20: pre-vault is exactly `amountMax` in
            // `lendingAsset`, so the delta is the simple difference.
            if (newAmountMax != oldAmountMax) {
                // T-407-C (#566) — keep the offer-principal lock in step
                // with the principal moving in / out of the creator's
                // vault. The lock delta equals the principal delta
                // exactly. On a SHRINK the refund withdraw below would
                // otherwise be blocked by its own still-active lock, so
                // the lock is dropped FIRST; on a GROW the deposit lands
                // before the lock widens (a deposit never touches the
                // withdraw chokepoint, so order there is cosmetic).
                if (newAmountMax < oldAmountMax) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                            offerId,
                            oldAmountMax - newAmountMax
                        ),
                        bytes4(0)
                    );
                    _pullOrRefundErc20(offer.lendingAsset, oldAmountMax, newAmountMax);
                } else {
                    _pullOrRefundErc20(offer.lendingAsset, oldAmountMax, newAmountMax);
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EncumbranceMutateFacet.incrementOfferPrincipalLien.selector,
                            offerId,
                            newAmountMax - oldAmountMax
                        ),
                        bytes4(0)
                    );
                }
            }
            return;
        }

        if (
            offer.offerType == LibVaipakam.OfferType.Borrower
            && (
                offer.assetType == LibVaipakam.AssetType.ERC721
                || offer.assetType == LibVaipakam.AssetType.ERC1155
            )
        ) {
            // Borrower NFT-rental: pre-vault is the rental prepay
            // computed from `amount × durationDays × (1 + bufferBps)`.
            // `amountMax` doesn't enter the prepay formula on this
            // shape (NFT rentals are structurally single-value, see
            // `_pullCreatorAssetsClassic`); `amount` is what moves
            // the prepay. Re-derive both sides using the offer's
            // `durationDays` (immutable per #193's scope).
            // Note: this uses the CURRENT bufferBps for both sides
            // of the diff. A governance bufferBps change between
            // create and modify will leave a tiny refund/pull
            // mismatch versus the actually-vaulted amount; see
            // docs/DesignsAndPlans/OfferModificationDesign.md.
            if (newAmount != oldAmount) {
                uint256 oldPrepay = _nftRentalPrepayTotal(oldAmount, offer.durationDays);
                uint256 newPrepay = _nftRentalPrepayTotal(newAmount, offer.durationDays);
                _pullOrRefundErc20(offer.prepayAsset, oldPrepay, newPrepay);
            }
            return;
        }

        // All other shapes (lender NFT rental, borrower ERC-20) have
        // no creator-side principal escrow keyed on `amount` /
        // `amountMax`, so updating storage alone is correct.
    }

    /// @dev Borrower ERC-20 path: pre-vault was `collateralAmountMax`
    ///      in `collateralAsset`. Delta math is the simple diff.
    function _settleCollateralDelta(
        uint256 offerId,
        LibVaipakam.Offer storage offer,
        uint256 oldCollateralAmountMax,
        uint256 newCollateralAmountMax
    ) private {
        if (newCollateralAmountMax == oldCollateralAmountMax) return; // idempotent

        if (
            offer.offerType == LibVaipakam.OfferType.Borrower
            && offer.assetType == LibVaipakam.AssetType.ERC20
            && offer.collateralAssetType == LibVaipakam.AssetType.ERC20
        ) {
            // #573 — keep the offer-collateral lock (the borrower-side
            // creator escrow) in step with the collateral moving in / out
            // of the vault, ordered so a SHRINK's refund isn't blocked by
            // its own still-active lock (symmetric to `_settleAmountDelta`'s
            // principal-lock handling). On a GROW the deposit lands before
            // the lock widens (a deposit never hits the withdraw guard).
            if (newCollateralAmountMax < oldCollateralAmountMax) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                        offerId,
                        oldCollateralAmountMax - newCollateralAmountMax
                    ),
                    bytes4(0)
                );
                _pullOrRefundErc20(
                    offer.collateralAsset,
                    oldCollateralAmountMax,
                    newCollateralAmountMax
                );
            } else {
                _pullOrRefundErc20(
                    offer.collateralAsset,
                    oldCollateralAmountMax,
                    newCollateralAmountMax
                );
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.incrementOfferPrincipalLien.selector,
                        offerId,
                        newCollateralAmountMax - oldCollateralAmountMax
                    ),
                    bytes4(0)
                );
            }
        }
        // Other shapes: no creator-side collateral escrow keyed on
        // `collateralAmountMax`, so storage-only update is correct.
    }

    /// @dev Generic ERC-20 vault delta: pulls or refunds the difference
    ///      between `oldAmount` and `newAmount` using the same vault
    ///      deposit / withdraw selectors `OfferCreateFacet` and
    ///      `OfferCancelFacet` use.
    function _pullOrRefundErc20(
        address token,
        uint256 oldAmount,
        uint256 newAmount
    ) private {
        if (newAmount > oldAmount) {
            uint256 pull = newAmount - oldAmount;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDepositERC20.selector,
                    msg.sender,
                    token,
                    pull
                ),
                VaultDepositFailed.selector
            );
        } else {
            uint256 refund = oldAmount - newAmount;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    msg.sender,
                    token,
                    msg.sender,
                    refund
                ),
                VaultWithdrawFailed.selector
            );
        }
    }

    /// @dev Codex round-3 P2 — re-run the T-034 periodic-interest-cadence
    ///      threshold check against the post-mutation `amount`. Mirrors
    ///      the subset of `OfferCreateFacet._validatePeriodicCadence`
    ///      that depends on `amount` (Filter 2 — principal-vs-threshold);
    ///      Filter 0 (both-liquid + ERC-20/ERC-20) is latched at create
    ///      and immutable through modify, and Filter 1 (cadence interval
    ///      < duration) depends only on the immutable `durationDays`, so
    ///      neither needs re-checking here.
    ///
    ///      Without this, a creator could open an offer above the
    ///      `minPrincipalForFinerCadence` threshold with a finer cadence
    ///      (e.g. Monthly), then shrink `amount` via `setOfferAmount` or
    ///      `modifyOffer` below the threshold while keeping Monthly —
    ///      a state `createOffer` rejects with `CadenceNotAllowed`.
    function _revalidatePeriodicCadenceForAmount(
        LibVaipakam.Offer storage offer,
        uint256 newAmount
    ) private view {
        LibVaipakam.PeriodicInterestCadence cadence = offer.periodicInterestCadence;
        bool isMultiYear = uint256(offer.durationDays) > 365;
        // None cadence on a non-multi-year offer is unconditionally
        // valid under createOffer's matrix — short-circuit so we don't
        // pay for the oracle lookup. Multi-year offers with cadence
        // None are already rejected at create (Row 3/4 require Annual),
        // so reaching this state would be a defensive impossibility;
        // we still run the threshold check in that case so a future
        // code path that bypassed create-time enforcement gets caught.
        if (cadence == LibVaipakam.PeriodicInterestCadence.None && !isMultiYear) {
            return;
        }

        LibVaipakam.ProtocolConfig storage cfgT034 =
            LibVaipakam.storageSlot().protocolCfg;
        uint256 threshold = cfgT034.minPrincipalForFinerCadence == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : cfgT034.minPrincipalForFinerCadence;

        uint256 principalNumeraire =
            _principalToNumeraire1e18(offer.lendingAsset, newAmount);
        bool aboveThreshold = principalNumeraire >= threshold;

        if (isMultiYear) {
            if (cadence == LibVaipakam.PeriodicInterestCadence.None) {
                // Row 3 / Row 4 — multi-year requires at least Annual.
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    uint256(offer.durationDays),
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
                    uint256(offer.durationDays),
                    principalNumeraire,
                    threshold
                );
            }
        } else {
            // ≤365d. Row 1 — None only below threshold; Row 2 — opt-in
            // to finer cadences allowed only at-or-above threshold.
            if (
                cadence != LibVaipakam.PeriodicInterestCadence.None &&
                !aboveThreshold
            ) {
                revert IVaipakamErrors.CadenceNotAllowed(
                    uint8(cadence),
                    uint256(offer.durationDays),
                    principalNumeraire,
                    threshold
                );
            }
        }
    }

    /// @dev Mirrors `OfferCreateFacet._principalToNumeraire1e18` so
    ///      create + modify see identical "is this above the cadence
    ///      threshold?" math. Fails soft to 0 when the oracle is
    ///      unconfigured or reverts (same fail-mode as create).
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

    /// @dev Rental prepay total = amount × days + (amount × days ×
    ///      rentalBufferBps / BASIS_POINTS). Mirrors the helper in
    ///      `OfferCreateFacet._nftRentalPrepayTotal` so create + modify
    ///      share the formula.
    function _nftRentalPrepayTotal(
        uint256 amount,
        uint256 durationDays
    ) private view returns (uint256) {
        uint256 prepayAmount = amount * durationDays;
        uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
            LibVaipakam.BASIS_POINTS;
        return prepayAmount + buffer;
    }

    /// @dev Emit the post-image snapshot in a single helper so the
    ///      three per-setter entries + the combined `modifyOffer` all
    ///      lay down identical events. Indexers filter by topic0.
    function _emitModified(uint256 offerId, LibVaipakam.Offer storage offer) private {
        emit OfferModified(
            offerId,
            offer.creator,
            offer.amount,
            offer.amountMax,
            offer.interestRateBps,
            offer.interestRateBpsMax,
            offer.collateralAmount,
            offer.collateralAmountMax
        );
    }
}
