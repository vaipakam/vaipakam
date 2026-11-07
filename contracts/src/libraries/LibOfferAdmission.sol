// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibNumeraireValueRead} from "./LibNumeraireValueRead.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibOfferAdmission
 * @author Vaipakam Developer Team
 * @notice The two bounds that keep the offer book from being flooded (#3242,
 *         owner decision 2026-11-07). Their one runtime copy is
 *         `OfferBookFacet`: every offer creation enters the book through its
 *         `openOfferOnBook`, and an offer whose amount changes is re-checked
 *         through its `requireOfferValueAdmitted`.
 *
 *           - A floor on the value of the principal, $10 by default on every
 *             chain, so no offer is too small for its loan's fees to cover
 *             the keeper's work on it. It binds only a principal the
 *             protocol values: a liquid ERC-20 with a price. An NFT, an
 *             illiquid token (which the protocol values at nothing, whatever
 *             feed it has) and a liquid token whose price cannot be read at
 *             this moment are never refused for their value.
 *           - A cap on the offers one wallet may have open at once, every
 *             offer type counted.
 *
 *         Offers that come from an existing loan are exempt from both: a
 *         sale or offset offer the protocol creates for a position, and a
 *         refinance offer. Refusing those would close a way out of a loan
 *         that already exists. Every partial fill is bounded too, without a
 *         check of its own: a fill is never smaller than the offer's
 *         `amount`, and a remainder smaller than that closes the offer.
 *
 *         The terms checks every creation runs first (duration, amount,
 *         sanctions, self-collateral, asset pause, rental prepay) stay in
 *         `OfferCreateFacet`, unchanged and in the same place.
 */
library LibOfferAdmission {
    /// @notice How a creation reaches offer creation.
    /// @dev `UserPosted`: `createOffer` / `createOfferWithPermit`, a wallet
    ///      posting its own offer. `OnBehalf`: `createOfferInternal`, the
    ///      protocol creating a sale or offset offer for an existing position.
    ///      `SignedMaterialize`: a signed off-chain offer turned into an
    ///      on-chain offer at the moment it is filled.
    enum Route {
        UserPosted,
        OnBehalf,
        SignedMaterialize
    }

    /// @notice #3242 — the principal is worth less than the floor. `value`
    ///         is the offer's `amount` valued in the active numeraire (1e18,
    ///         rounded down); `minimum` is the floor in effect.
    error OfferBelowMinimumValue(uint256 value, uint256 minimum);
    /// @notice #3242 — the wallet already has `open` offers open and the cap
    ///         is `cap`. Cancelling one (an expired one too: an expired offer
    ///         stays open until cancelled) makes room.
    error TooManyOpenOffers(uint256 open, uint256 cap);

    /// @notice Reverts with the first bound `offer`, just written by a
    ///         creation through `route`, breaks; returns when it is admitted.
    /// @dev Runs before the offer is counted as open, so the cap compares the
    ///      creator's count without this offer.
    function enforceBounds(LibVaipakam.Offer storage offer, Route route) internal view {
        if (route == Route.OnBehalf || offer.refinanceTargetLoanId != 0) return;
        enforceValue(offer.lendingAsset, offer.assetType, offer.amount);
        // A signed offer is filled the moment it exists, so it never adds to
        // the open book the cap bounds.
        if (route == Route.UserPosted) {
            uint256 open = LibVaipakam.storageSlot().openOfferCount[offer.creator];
            uint256 cap = LibVaipakam.cfgMaxOpenOffersPerWallet();
            if (open >= cap) revert TooManyOpenOffers(open, cap);
        }
    }

    /// @notice Reverts {OfferBelowMinimumValue} when a liquid ERC-20
    ///         principal of `amount` can be priced and is worth less than the
    ///         floor; returns otherwise. A principal that is not an ERC-20, is
    ///         not liquid, or whose value the shared rule cannot give now, is
    ///         admitted.
    /// @dev Liquidity is read first and on its own, never inferred from a
    ///      zero value: a liquid amount too small to be worth one unit also
    ///      values at zero, and it must be refused, not admitted.
    function enforceValue(address lendingAsset, LibVaipakam.AssetType assetType, uint256 amount)
        internal
        view
    {
        if (assetType != LibVaipakam.AssetType.ERC20) return;
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeCall(OracleFacet.checkLiquidity, (lendingAsset))
        );
        if (!ok || ret.length < 32) return;
        if (abi.decode(ret, (LibVaipakam.LiquidityStatus)) != LibVaipakam.LiquidityStatus.Liquid) return;
        (bool priced, uint256 value) = LibNumeraireValueRead.tryValue(lendingAsset, amount, false);
        if (!priced) return;
        uint256 minimum = LibVaipakam.cfgMinOfferValueNumeraire();
        if (value < minimum) revert OfferBelowMinimumValue(value, minimum);
    }
}
