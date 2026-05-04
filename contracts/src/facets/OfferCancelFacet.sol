// src/facets/OfferCancelFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
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
    event OfferCanceled(uint256 indexed offerId, address indexed creator);

    /// @dev Re-declared from OfferFacet for the same reason. Frontend
    ///      "Your Offers / Cancelled" surfaces hydrate cancelled rows
    ///      from this event.
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
    event OfferClosed(uint256 indexed offerId, OfferCloseReason reason);

    // ── Errors ──────────────────────────────────────────────────────
    error OfferAlreadyAccepted();
    /// Cancel fired before `MIN_OFFER_CANCEL_DELAY` elapsed since
    /// `Offer.createdAt` and `amountFilled == 0` (no match landed yet).
    /// Partial-filled offers can be cancelled immediately and don't
    /// raise this.
    error CancelCooldownActive();

    /**
     * @notice Cancels an unaccepted offer and returns the locked assets.
     * @dev Creator-only (enforced via {LibAuth.requireOfferCreator}).
     *      Releases whatever was actually locked during
     *      {OfferFacet.createOffer}: principal (Lender side) or
     *      collateral / rental prepay+buffer (Borrower side), matching
     *      the original asset type. Burns the offer position NFT.
     *      Range Orders Phase 1: when partial-fills exist
     *      (`amountFilled > 0`) the storage record is preserved and
     *      `accepted = true`; otherwise the slot is deleted for the gas
     *      refund. Reverts NotOfferCreator, OfferAlreadyAccepted, or
     *      CancelCooldownActive.
     * @param offerId The offer ID to cancel.
     */
    function cancelOffer(uint256 offerId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        LibAuth.requireOfferCreator(offer);
        if (offer.accepted) revert OfferAlreadyAccepted();

        // ── Range Orders Phase 1 — cancel cooldown ─────────────────
        // Active ONLY when the master `partialFillEnabled` flag is on.
        // Defends against the cancel-front-run vector on the matching
        // path: an attacker can't watch matchOffers in mempool, race a
        // cancelOffer in, and reclaim escrowed assets before the match
        // lands. With matching dormant (default), there's no front-run
        // vector, so the cooldown stays off. Partial-filled offers
        // (`amountFilled > 0`) bypass the cooldown unconditionally —
        // the lender already committed value through prior matches.
        if (
            s.protocolCfg.partialFillEnabled
            && offer.amountFilled == 0
            && offer.createdAt != 0
            && block.timestamp < uint256(offer.createdAt) + LibVaipakam.MIN_OFFER_CANCEL_DELAY
        ) {
            revert CancelCooldownActive();
        }

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

        if (offer.offerType == LibVaipakam.OfferType.Lender) {
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
                // Range Orders Phase 1 — refund only the UNFILLED
                // portion. createOffer pre-escrowed `amountMax`; each
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
            // Borrower: unlock what was actually deposited at create.
            if (offer.assetType == LibVaipakam.AssetType.ERC20) {
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
                // NFT rental borrower offer: ERC-20 prepayment was deposited.
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
        // reference this offer's terms via `Loan.offerId`. Mark
        // `accepted = true` so the open-book queries skip it; the
        // storage slot stays intact. Zero-fill cancels (no matches)
        // delete normally — frees the slot for gas refund.
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
