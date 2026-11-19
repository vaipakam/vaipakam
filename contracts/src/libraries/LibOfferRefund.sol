// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibRevert} from "./LibRevert.sol";

/// @dev The refund host's entry, for the self-call encoding.
interface IOfferRefundHost {
    function refundOfferEscrow(
        uint256 offerId,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        bool byHolder
    ) external;
}

/**
 * @title  LibOfferRefund
 * @author Vaipakam Developer Team
 * @notice #3744 — an open offer's escrow follows the holder of the offer's
 *         position token: what it returns goes to that holder's vault as
 *         free balance, and the rights to cancel and edit it are that
 *         holder's account manager's. One host carries the refund
 *         (`OfferCancelFacet.refundOfferEscrow`); every step that returns an
 *         offer's escrow reaches it through {refund}, so the rule is written
 *         once and no step names a payee.
 */
library LibOfferRefund {
    /// @notice Return `amount` of offer `offerId`'s escrow (`kind`, `asset`,
    ///         `tokenId`) to the holder of its position token. The caller has
    ///         already dropped the escrow's lien by the amount.
    /// @param byHolder True when the holder's own manager is acting (a cancel
    ///        or edit it signed): the payout must succeed. False for a step
    ///        someone else triggered (a match, a fill, an expired cleanup):
    ///        a holder who cannot be paid then never blocks it, and the
    ///        amount stays in the creator's vault, held for the token.
    function refund(uint256 offerId, uint8 kind, address asset, uint256 tokenId, uint256 amount, bool byHolder)
        internal
    {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeCall(IOfferRefundHost.refundOfferEscrow, (offerId, kind, asset, tokenId, amount, byHolder))
        );
        LibRevert.bubbleOnFailure(ok, ret, "offer refund");
    }

    /// @notice The holder of offer `offer`'s position token now, or its
    ///         creator for an offer that carries none.
    function holder(LibVaipakam.Offer storage offer) internal view returns (address h) {
        uint256 token = offer.positionTokenId;
        if (token != 0) h = LibPositionNFT.core().holderOf(token);
        if (h == address(0)) h = offer.creator;
    }

    /// @notice Whether `caller` manages the holder of `offer`'s position
    ///         token: the holder's own wallet, or its controller once a
    ///         protected-account replacement retired it.
    function managedBy(LibVaipakam.Offer storage offer, address caller) internal view returns (bool) {
        return caller == LibProtectedAccount.manager(holder(offer));
    }
}
