// src/facets/OfferCancelFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
// #195 — `LibAuth.requireOfferCreator` is replaced by an inline access
// gate that admits the creator OR any caller against an expired offer;
// see `cancelOffer` for the full rule.
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";

/**
 * @title OfferCancelFacet
 * @author Vaipakam Developer Team
 * @notice Cancellation of unaccepted offers + read-only views over the
 *         offer book. Carved out of `OfferFacet` to bring it under the
 *         EIP-170 24576-byte runtime ceiling — same precedent as
 *         `OfferMatchFacet`. Selectors land on the diamond identically,
 *         so frontend / keeper-bot bindings are unaffected by the
 *         move. Conceptually the cut also makes sense: cancel + read
 *         are a separate concern from create + accept.
 *
 *         Hosted entry points:
 *           - `cancelOffer(offerId)` — creator-only; refunds
 *             whatever was locked at create-time, burns the position
 *             NFT, and emits `OfferCanceled` + `OfferCanceledDetails`
 *             + `OfferClosed(reason=Cancelled)`.
 *           - `getCompatibleOffers(user, offset, limit)` — paginated
 *             open-book scan filtered by trade-pair compatibility.
 *           - `getOffer(offerId)` / `getOfferDetails(offerId)` —
 *             struct-returning views; latter is the README §13.3
 *             alias.
 */
contract OfferCancelFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @dev Re-declared from OfferFacet so the same topic0 lands on
    ///      every cancel regardless of which facet emits — indexers
    ///      filter by signature, so this stays compatible with
    ///      whatever was indexing OfferFacet.OfferCanceled before
    ///      the split.
    /// @custom:event-category state-change/offer-mutation
    event OfferCanceled(uint256 indexed offerId, address indexed creator);

    /// @dev Re-declared from OfferFacet for the same reason. Frontend
    ///      "Your Offers / Cancelled" surfaces hydrate cancelled rows
    ///      from this event.
    /// @custom:event-category state-change/offer-mutation
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
        uint256 amountMax,
        uint256 interestRateBpsMax,
        uint256 amountFilled
    );

    /// @dev Re-declared from OfferFacet / OfferMatchFacet for ABI
    ///      continuity. Topic0 is identical across all three facets.
    enum OfferCloseReason { FullyFilled, Dust, Cancelled }
    /// @custom:event-category state-change/offer-mutation
    event OfferClosed(uint256 indexed offerId, OfferCloseReason reason);

    // ── Errors ──────────────────────────────────────────────────────
    error OfferAlreadyAccepted();
    /// @notice T-086 Round-8 (#358) Codex round-2 P1 #1 — raised when
    ///         cancelOffer is called on an offer already consumed by a
    ///         parallel sale (Scenario A terminal). Without this gate
    ///         an ERC1155 borrower could double-withdraw collateral
    ///         that's already gone in the Seaport sale.
    error OfferAlreadyConsumedBySale(uint96 offerId);
    /// Cancel fired before `MIN_OFFER_CANCEL_DELAY` elapsed since
    /// `Offer.createdAt` and `amountFilled == 0` (no match landed yet).
    /// Partial-filled offers can be cancelled immediately and don't
    /// raise this.
    error CancelCooldownActive();
    /// #195 — caller is neither the offer creator nor cancelling an
    /// expired offer. Surfaces `(creator, expiresAt)` so the caller's
    /// UI can render either "you're not the creator" or "this offer
    /// hasn't expired yet" without an additional read. The lazy-clear
    /// path widens the access gate to "anyone can clear when expired",
    /// but the refund still routes to `creator` so the cleaner gets
    /// no kickback — the SSTORE-clear gas refund discount they earn on
    /// their own tx is the only economic incentive, and it's bounded
    /// (EIP-3529 caps refunds at 1/5 of gas used).
    error NotCreatorOrNotExpired(address creator, uint64 expiresAt);

    /**
     * @notice Cancels an unaccepted offer and returns the locked assets.
     * @dev Access gate (post-#195):
     *      - The creator can cancel their own offer unconditionally
     *        (this is the legacy path; semantics unchanged).
     *      - ANYONE can cancel an offer whose GTT deadline has elapsed
     *        (`expiresAt != 0 && block.timestamp >= expiresAt`). The
     *        refund still routes to `offer.creator` — the cleaner pays
     *        gas and earns only the SSTORE-clear gas-refund discount
     *        on their own tx (capped at 1/5 per EIP-3529). This is the
     *        lazy permissionless-clear path; no keeper sweep, no
     *        bounty, no treasury cut.
     *
     *      Releases whatever was actually locked during
     *      {OfferFacet.createOffer}: principal (Lender side) or
     *      collateral / rental prepay+buffer (Borrower side), matching
     *      the original asset type. Burns the offer position NFT.
     *      Range Orders Phase 1: when partial-fills exist
     *      (`amountFilled > 0`) the storage record is preserved and
     *      `accepted = true`; otherwise the slot is deleted for the gas
     *      refund. Reverts NotCreatorOrNotExpired, OfferAlreadyAccepted,
     *      or CancelCooldownActive.
     * @param offerId The offer ID to cancel.
     */
    function cancelOffer(uint256 offerId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        // #195 — access gate widened. Either the creator (unconditional)
        // or any caller against an expired offer can cancel; the refund
        // destination is `offer.creator` in both branches (see below),
        // so the cleaner never receives the creator's vaulted assets.
        // Note: an `expiresAt == 0` (GTC) offer can be cancelled only
        // by its creator — `isOfferExpired` returns false on the GTC
        // sentinel, so the second branch evaluates `false`.
        address creator = offer.creator;
        if (creator != msg.sender && !LibVaipakam.isOfferExpired(offer)) {
            revert NotCreatorOrNotExpired(creator, offer.expiresAt);
        }
        if (offer.accepted) revert OfferAlreadyAccepted();
        // T-086 Round-8 (#358) Codex round-2 P1 #1 — block cancel of a
        // sold offer. The §19.4 Scenario A terminal already marked the
        // offer consumed (the collateral NFT is gone, proceeds credited
        // to the borrower's vault). Without this gate, an ERC1155
        // borrower whose vault still holds the same (collection, id)
        // backing another open position could call cancelOffer to
        // double-withdraw `collateralQuantity`, draining collateral
        // from the OTHER offer / loan. The §19.7e ConsumedBySale
        // terminal is final; subsequent cancel attempts MUST revert.
        if (s.offerConsumedBySale[offerId]) {
            revert OfferAlreadyConsumedBySale(uint96(offerId));
        }

        // ── Range Orders Phase 1 — cancel cooldown ─────────────────
        // Active ONLY when the master `partialFillEnabled` flag is on.
        // Defends against the cancel-front-run vector on the matching
        // path: an attacker can't watch matchOffers in mempool, race a
        // cancelOffer in, and reclaim vaulted assets before the match
        // lands. With matching dormant (default), there's no front-run
        // vector, so the cooldown stays off. Partial-filled offers
        // (`amountFilled > 0`) bypass the cooldown unconditionally —
        // the lender already committed value through prior matches.
        //
        // #195 — EXPIRED offers also bypass the cooldown. Rationale:
        // every accept / match path refuses to bind an expired offer
        // to a loan (the `isOfferExpired` gate in `_acceptOffer` and
        // `previewMatch`), so a front-run cancel against an expired
        // offer can't grief anyone — there's nothing left to race.
        // Without this bypass an expiresAt < createdAt + 5 min offer
        // would be stuck "expired but uncleanable" until the cooldown
        // separately elapsed, which is a UX cliff with no defensive
        // value.
        if (
            s.protocolCfg.partialFillEnabled
            && offer.amountFilled == 0
            && offer.createdAt != 0
            && block.timestamp < uint256(offer.createdAt) + LibVaipakam.MIN_OFFER_CANCEL_DELAY
            && !LibVaipakam.isOfferExpired(offer)
        ) {
            revert CancelCooldownActive();
        }

        // T-086 Round-8 (#358) §19.7c — parallel-sale teardown. If the
        // borrower opted into a parallel-sale listing AND posted one,
        // the executor + vault + diamond bindings must be cleared
        // BEFORE the refund path attempts to interact with the
        // collateral NFT (a stale executor binding would let a buyer's
        // Seaport fill route around the cancel until the executor's
        // dispatch-disjoint invariant catches it). Idempotent — no-op
        // when no listing is live.
        LibPrepayCleanup.clearOfferListing(uint96(offerId));

        // ── Strategic-flow NFT unlock on cancel ─────────────────────────────
        // requireOfferCreator above bound msg.sender to offer.creator.
        // For the native-lock design the position NFT never leaves its
        // owner; we only clear the LibERC721 lock to restore ordinary
        // transfer rights.
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

        // #195 — refund destination is ALWAYS the creator's vault (and
        // the creator's wallet for the withdraw target), never
        // `msg.sender`. On the legacy creator-cancel path these are the
        // same address; on the new lazy-clear path the cleaner is NOT
        // the creator, so routing via `msg.sender` would let an
        // arbitrary third party drain the creator's vaulted principal
        // / collateral / prepay. The access-gate widening above is
        // safe ONLY because every withdraw below targets `creator`.
        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // T-407-C (#566) — release the offer-principal lock
                // BEFORE the refund withdraw. The remaining lien covers
                // exactly the unfilled principal about to be returned;
                // if it stayed active, the vault-withdraw chokepoint
                // would treat that principal as encumbered and block the
                // creator's own refund. Idempotent + a no-op on offers
                // that never carried a lien (covers the partial-filled
                // case too — prior matches already decremented it).
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                        offerId
                    ),
                    bytes4(0)
                );
                // Range Orders Phase 1 — refund only the UNFILLED
                // portion. createOffer pre-vaulted `amountMax`; each
                // partial match consumed a slice. Legacy single-value
                // offers satisfy `amountMax == amount && amountFilled
                // == 0`, so the refund equals `amount`.
                uint256 effAmountMax = offer.amountMax == 0
                    ? offer.amount
                    : offer.amountMax;
                uint256 refund = effAmountMax - offer.amountFilled;
                if (refund > 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
                            creator,
                            offer.lendingAsset,
                            creator,
                            refund
                        ),
                        VaultWithdrawFailed.selector
                    );
                }
            } else if (offer.assetType == LibVaipakam.AssetType.ERC721) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC721.selector,
                        creator,
                        offer.lendingAsset,
                        offer.tokenId,
                        creator
                    ),
                    VaultWithdrawFailed.selector
                );
            } else if (offer.assetType == LibVaipakam.AssetType.ERC1155) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC1155.selector,
                        creator,
                        offer.lendingAsset,
                        offer.tokenId,
                        offer.quantity,
                        creator
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else {
            // Borrower: unlock what was actually deposited at create.
            // #576 — a CARRY-OVER refinance offer pledged NO fresh collateral
            // and created no escrow lock (both skipped at create), so there is
            // nothing to refund on cancel; trying to withdraw never-deposited
            // collateral would revert. The collateral-return withdraws below
            // are therefore gated on `!carryOver`. (The
            // `releaseOfferPrincipalLien` is idempotent — a no-op when no lock
            // exists — so it stays unconditional.)
            bool carryOver = LibAutoRefinanceCheck.isCarryOver(
                s,
                offer.refinanceTargetLoanId,
                offer.creator,
                offer.collateralAmount,
                offer.collateralAmountMax
            );
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                if (offer.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    // #573 — release the offer-collateral lock BEFORE the
                    // refund withdraw (symmetric to the lender-principal
                    // release above). The remaining lock covers exactly
                    // the unfilled collateral about to be returned; left
                    // active, the vault-withdraw chokepoint would treat it
                    // as encumbered and block the creator's own refund.
                    // Idempotent + a no-op on offers that never carried a
                    // lock (covers the partial-filled case — prior matches
                    // decremented it).
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                            offerId
                        ),
                        bytes4(0)
                    );
                    // Issue #164 — `createOffer` pre-vaults the
                    // UPPER bound (`collateralAmountMax`, post auto-
                    // collapse). Legacy fallback (`collateralAmountMax
                    // == 0` from a pre-#164 storage row) reads as
                    // `collateralAmount`.
                    //
                    // Codex P0 on #102 round-1 — under partial-fill,
                    // a borrower offer can be cancelled AFTER some
                    // matches have already minted loans against it
                    // (`offer.accepted` stays false until dust-close).
                    // The cancel-refund must subtract
                    // `collateralAmountFilled` (the portion of pre-
                    // vaulted collateral that's BACKING LIVE LOANS),
                    // otherwise the borrower withdraws collateral that
                    // still collateralises open obligations — a real
                    // fund-lock vector. Symmetric with the lender
                    // side's `effAmountMax - amountFilled` refund.
                    uint256 borrowerColMax = offer.collateralAmountMax == 0
                        ? offer.collateralAmount
                        : offer.collateralAmountMax;
                    uint256 borrowerColRefund = borrowerColMax - offer.collateralAmountFilled;
                    if (borrowerColRefund > 0 && !carryOver) {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultWithdrawERC20.selector,
                                creator,
                                offer.collateralAsset,
                                creator,
                                borrowerColRefund
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    if (!carryOver) {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultWithdrawERC721.selector,
                                creator,
                                offer.collateralAsset,
                                offer.collateralTokenId,
                                creator
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                } else if (offer.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    if (!carryOver) {
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultWithdrawERC1155.selector,
                                creator,
                                offer.collateralAsset,
                                offer.collateralTokenId,
                                offer.collateralQuantity,
                                creator
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                }
            } else if (
                offer.assetType == LibVaipakam.AssetType.ERC721 ||
                offer.assetType == LibVaipakam.AssetType.ERC1155
            ) {
                // NFT rental borrower offer: ERC-20 prepayment was deposited.
                uint256 prepayAmount = offer.amount * offer.durationDays;
                uint256 buffer = (prepayAmount * LibVaipakam.cfgRentalBufferBps()) /
                    LibVaipakam.BASIS_POINTS;
                uint256 totalPrepay = prepayAmount + buffer;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        creator,
                        offer.prepayAsset,
                        creator,
                        totalPrepay
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        }

        // Burn position NFT (not the underlying asset tokenId).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                offer.positionTokenId
            ),
            NFTBurnFailed.selector
        );

        // Stamp the cancel marker BEFORE any storage delete so
        // `offers[id]` going zero isn't mistaken for "never existed"
        // by readers. The `userOfferIds` reverse index still contains
        // the id — indexers that want to display "cancelled" as a
        // terminal state read this map.
        s.offerCancelled[offerId] = true;
        LibMetricsHooks.onOfferCancelled(offerId);

        // Emit the detail variant BEFORE the storage delete so the
        // field values are still readable. Frontend "Your Offers /
        // Cancelled" surfaces hydrate cancelled rows from this event;
        // the companion `OfferCanceled` keeps emitting for historical
        // consumers that only need identity (id + creator).
        //
        // #195 — log the creator (NOT `msg.sender`) so a lazy-clear
        // landed by a third party still attributes the cancelled offer
        // back to its real creator. Indexers that key on the second
        // topic for "Your Offers / Cancelled" need this; otherwise an
        // expired offer cleared by bob would vanish from alice's
        // history when she should still see it as terminal.
        emit OfferCanceledDetails(
            offerId,
            creator,
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
        // reference this offer's terms via `Loan.offerId`. Mark
        // `accepted = true` so the open-book queries skip it; the
        // storage slot stays intact. Zero-fill cancels (no matches)
        // delete normally — frees the slot for gas refund.
        //
        // Clear the offer-NFT reverse mapping in both branches: the
        // offer is no longer "open" so `getUserPositionOffers` should
        // not return it for the current NFT holder. The NFT itself
        // stays around (the holder keeps it as a historical artifact
        // or burns it via the existing burn path).
        delete s.offerIdByPositionTokenId[offer.positionTokenId];
        if (offer.amountFilled > 0) {
            offer.accepted = true;
        } else {
            delete s.offers[offerId];
        }

        // #195 — attribute the cancellation to the original creator,
        // not `msg.sender`. Same rationale as `OfferCanceledDetails`
        // above; both events must keep the creator as their indexed
        // address so historical filters continue to work.
        emit OfferCanceled(offerId, creator);
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
