// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
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

    /// @notice #3744 — the owner of the loan side an ACCEPTOR takes: in a
    ///         match, the holder of the matched lender offer's position token
    ///         (the creator's vault still funds it, and `loan.lender` stays
    ///         the creator as the funding-vault record); otherwise the
    ///         acceptor itself. A lender offer that carries no position token
    ///         of its own keeps its creator.
    function acceptorSideOwner(address acceptor) internal view returns (address) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.matchOverride.active) return acceptor;
        uint256 lenderOfferId = s.matchLenderAuthOfferId;
        if (lenderOfferId == 0) return acceptor;
        LibVaipakam.Offer storage lo = s.offers[lenderOfferId];
        if (lo.creator != acceptor) return acceptor;
        return holder(lo);
    }

    bytes32 private constant SLICE_TOKEN_TO = keccak256("vaipakam.offer.sliceTokenTo");

    /// @notice #3744 — a collection offer's one-loan slice is minted with its
    ///         position token in the hands of the holder of the PARENT
    ///         offer's token, so the loan side it creates follows the parent.
    ///         Set by the slice's drawer for the next offer token minted in
    ///         this transaction; {takeSliceTokenTo} consumes it.
    function bindSliceTokenTo(address to) internal {
        bytes32 key = SLICE_TOKEN_TO;
        assembly ("memory-safe") {
            tstore(key, to)
        }
    }

    /// @notice Who receives the offer token being minted for `creator`: the
    ///         bound slice recipient once (then cleared), else the creator.
    function takeSliceTokenTo(address creator) internal returns (address to) {
        bytes32 key = SLICE_TOKEN_TO;
        assembly ("memory-safe") {
            to := tload(key)
        }
        if (to == address(0)) return creator;
        assembly ("memory-safe") {
            tstore(key, 0)
        }
    }
}
