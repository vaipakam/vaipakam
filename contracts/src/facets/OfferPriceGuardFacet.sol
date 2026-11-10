// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferPriceGuard} from "../libraries/LibOfferPriceGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  OfferPriceGuardFacet
 * @author Vaipakam Developer Team
 * @notice #3358 — the maker's price-move guard (owner decision 2026-11-08).
 *
 *         An offer waits on the book while the market moves. A taker can
 *         fill it the moment the price has moved in the taker's favour, at
 *         terms the maker set against the old price. The guard lets the
 *         maker bound that: a guarded offer refuses a fill when the
 *         collateral/principal rate has moved more than the maker's limit
 *         since the guard was recorded, or when the pair is not calm against
 *         the last two hourly price checkpoints (the calm rule forced sales
 *         use). It is off by default and only ever refuses a fill; it moves
 *         no funds and changes no term of a loan.
 *
 *         Two ways to set it, both the creator's own:
 *         - {armOfferPriceGuard} BEFORE posting, in the same transaction
 *           (batched with the post through `MulticallFacet`): the guard is
 *           recorded inside the posting itself, with the prices at posting,
 *           so the offer is never on the book unguarded;
 *         - {setOfferPriceGuard} on an offer already posted: recorded from
 *           the prices when it is set. Between the post and that call the
 *           offer is unguarded.
 *
 *         Every fill reads it at one place, loan creation
 *         (`LoanFacet.initiateLoan` self-calls {requireOfferPriceGuardsClear}
 *         for the accepted offer and, in a match, the lender offer too), so
 *         a direct accept, every match path and every acceptance that opens
 *         a loan from an offer are covered. `previewAccept` and
 *         `previewMatch` report a refusal as `PriceGuardRefused`, and
 *         {getOfferPriceGuard} says which condition holds and by how much.
 *
 *         Not covered: a gasless signed offer, which is put on the book only
 *         at its fill, by the taker; its signer cannot arm a guard (the
 *         signed terms carry none yet, see #3327).
 *
 * @dev    The guard needs the hourly checkpoints the forced-sale floor reads
 *         (`SaleFloorFacet.checkpointHourlyPrices`, permissionless, backed by
 *         a keeper pass). While the last two hours of either asset are
 *         missing, a guarded offer cannot be filled, and the views say so.
 */
contract OfferPriceGuardFacet is DiamondPausable, IVaipakamErrors {
    /// @notice An offer's guard and where it stands now.
    /// @param maxMoveBps             The creator's limit; 0 = no guard.
    /// @param setAt                  When it was recorded (unix seconds).
    /// @param refCollateralPrice1e18 The collateral asset's oracle price then.
    /// @param refPrincipalPrice1e18  The principal asset's oracle price then.
    /// @param status                 See {LibOfferPriceGuard.Status}.
    /// @param moveBps                How far the rate has moved since, in bps
    ///                               of the recorded rate, rounded up (0 when
    ///                               it cannot be measured now).
    /// @param calmMoveBps            The calm bound in effect, in bps.
    struct OfferPriceGuardView {
        uint16 maxMoveBps;
        uint64 setAt;
        uint256 refCollateralPrice1e18;
        uint256 refPrincipalPrice1e18;
        LibOfferPriceGuard.Status status;
        uint256 moveBps;
        uint16 calmMoveBps;
    }

    error InvalidOffer();
    error OfferAlreadyAccepted();

    /// @notice The rate moved `moveBps` since the guard was recorded, past the
    ///         creator's limit of `maxMoveBps`.
    error OfferPriceMoved(uint256 offerId, uint256 moveBps, uint256 maxMoveBps);
    /// @notice A checkpoint for one of the last two hours is missing for an
    ///         asset of the offer, so the pair cannot be shown to be calm.
    error OfferPairNoCheckpoint(uint256 offerId);
    /// @notice The pair moved past the calm bound against one of the last two
    ///         hourly checkpoints.
    error OfferPairNotCalm(uint256 offerId);
    /// @notice A current price of one of the offer's assets cannot be read.
    error OfferPriceUnreadable(uint256 offerId);

    /**
     * @notice Arm a guard for the next offer you post in this transaction.
     * @dev    Batch it ahead of the post through `MulticallFacet`. The post
     *         records it with the prices at posting and emits
     *         `OfferPriceGuardSet`; a post whose pair cannot be priced (not
     *         ERC-20 on both legs, or no current price) is refused with
     *         `OfferPriceGuardUnpriced`. Applies to the first offer created
     *         with you as its creator in this transaction, and to that one
     *         only; it lapses with the transaction.
     * @param maxMoveBps The most the collateral/principal rate may move, in
     *        bps, within [{OFFER_PRICE_GUARD_BPS_MIN},
     *        {OFFER_PRICE_GUARD_BPS_MAX}].
     */
    function armOfferPriceGuard(uint16 maxMoveBps) external whenNotPaused {
        _requireInRange(maxMoveBps);
        LibOfferPriceGuard.arm(msg.sender, maxMoveBps);
    }

    /**
     * @notice Set, change or clear the guard on an offer you posted and that
     *         is still open.
     * @dev    A non-zero limit is recorded from the prices now; 0 clears it.
     *         Changing it re-records the prices. The pair must be priceable
     *         (`OfferPriceGuardUnpriced` otherwise).
     * @param offerId    The offer.
     * @param maxMoveBps The limit in bps, in range, or 0 to clear.
     */
    function setOfferPriceGuard(uint256 offerId, uint16 maxMoveBps) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.creator == address(0)) revert InvalidOffer();
        if (o.accepted) revert OfferAlreadyAccepted();
        if (msg.sender != o.creator) revert NotOfferCreator();
        if (maxMoveBps == 0) {
            LibOfferPriceGuard.clear(s, offerId);
            return;
        }
        _requireInRange(maxMoveBps);
        LibOfferPriceGuard.record(s, offerId, maxMoveBps);
    }

    /// @notice `offerId`'s guard and where it stands now.
    function getOfferPriceGuard(uint256 offerId) external view returns (OfferPriceGuardView memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.OfferPriceGuard storage g = s.offerPriceGuard[offerId];
        v.maxMoveBps = g.maxMoveBps;
        v.setAt = g.setAt;
        v.refCollateralPrice1e18 = g.refCollateralPrice1e18;
        v.refPrincipalPrice1e18 = g.refPrincipalPrice1e18;
        (v.status, v.moveBps) = LibOfferPriceGuard.status(s, offerId);
        v.calmMoveBps = LibVaipakam.cfgSaleFloor().calmMoveBps;
    }

    /**
     * @notice Reverts with the named refusal when a fill of `offerId`, or of
     *         `otherOfferId` (0 = none), would be refused by its guard now;
     *         returns otherwise. An offer with no guard always passes.
     * @dev    The one check every fill runs, from loan creation, and the one
     *         the accept and match previews ask.
     */
    function requireOfferPriceGuardsClear(uint256 offerId, uint256 otherOfferId) external view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _requireClear(s, offerId);
        if (otherOfferId != 0) _requireClear(s, otherOfferId);
    }

    function _requireClear(LibVaipakam.Storage storage s, uint256 offerId) private view {
        (LibOfferPriceGuard.Status st, uint256 moved) = LibOfferPriceGuard.status(s, offerId);
        if (st == LibOfferPriceGuard.Status.Moved) {
            revert OfferPriceMoved(offerId, moved, s.offerPriceGuard[offerId].maxMoveBps);
        }
        if (st == LibOfferPriceGuard.Status.NoCheckpoint) revert OfferPairNoCheckpoint(offerId);
        if (st == LibOfferPriceGuard.Status.NotCalm) revert OfferPairNotCalm(offerId);
        if (st == LibOfferPriceGuard.Status.Unpriced) revert OfferPriceUnreadable(offerId);
    }

    function _requireInRange(uint16 maxMoveBps) private pure {
        if (
            maxMoveBps < LibVaipakam.OFFER_PRICE_GUARD_BPS_MIN
                || maxMoveBps > LibVaipakam.OFFER_PRICE_GUARD_BPS_MAX
        ) {
            revert ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("offerPriceGuardBps"),
                maxMoveBps,
                LibVaipakam.OFFER_PRICE_GUARD_BPS_MIN,
                LibVaipakam.OFFER_PRICE_GUARD_BPS_MAX
            );
        }
    }
}
