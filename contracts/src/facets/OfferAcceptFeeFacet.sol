// src/facets/OfferAcceptFeeFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibFeeEntitlement} from "../libraries/LibFeeEntitlement.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title OfferAcceptFeeFacet
 * @author Vaipakam Developer Team
 * @notice The borrower's Loan Initiation Fee charge and the net-principal
 *         delivery for a new ERC-20 loan — the last money movement of an
 *         accept.
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      SPLIT FROM {OfferAcceptFacet} for EIP-170 headroom, along a seam that
 *      was ALREADY a Diamond boundary. `chargeBorrowerLifAndDeliver` has been
 *      `external` and `msg.sender == address(this)`-gated since it was written,
 *      and `_acceptOffer` reaches it through `LibFacet.crossFacetCall` — not
 *      for modularity but because the charge needs a FRESH STACK FRAME: the
 *      HoldOnly discount staticcall plus three vault withdraws would otherwise
 *      land their depth in `_acceptOffer`, which sits at the viaIR
 *      stack-too-deep budget.
 *
 *      So this facet does not introduce a boundary; it moves an implementation
 *      to the other side of one that already existed. The call site is
 *      unchanged in shape, and — the property that makes the move safe — the
 *      4-byte SELECTOR is unchanged too, because a selector is derived from the
 *      signature and not from the contract that hosts it. The Diamond simply
 *      routes the same selector to a different address.
 *
 *      WHY IT HAD TO MOVE: `OfferAcceptFacet` reached 24,412 bytes, leaving 164
 *      under the 24,576-byte limit. That is less than one cross-facet call, so
 *      the facet could not grow at all — and #1835's pre-mirroring sale-listing
 *      refusal, plus anything else needing to touch the accept path, was
 *      undeployable rather than merely unwritten. The same condition that
 *      forced #1780's `EarlyWithdrawalFacet` split, which was at 30 bytes.
 *
 *      WHAT DID NOT MOVE, and why the seam stops here:
 *        - `_fullTariffShouldRun` is called by `_acceptOffer`, not by this
 *          charge, so moving it would ADD a cross-facet hop to the hot path
 *          rather than remove one.
 *        - `_calculateTransactionValueNumeraire` is likewise consumed directly
 *          by `_acceptOffer`; its public wrapper stays beside it so the private
 *          helper has one home.
 *      Both are on the other side of the boundary from this facet's work, and
 *      moving code across a boundary it does not already sit on is how a split
 *      buys bytes at the cost of gas and a new failure mode.
 *
 *      TRUST MODEL: identical to the `vaultWithdrawERC20` cross-facet calls it
 *      wraps. The `address(this)` gate is the whole of it — this facet moves a
 *      lender's funded principal and must never be reachable from outside the
 *      Diamond.
 */
contract OfferAcceptFeeFacet is IVaipakamErrors {
    /// @notice Diamond-internal: the full borrower LIF charge + net delivery
    ///         for a NEW (non-sale) ERC-20 loan (#1352).
    /// @dev    Deliberately an EXTERNAL, `msg.sender == address(this)`-gated
    ///         method invoked by {OfferAcceptFacet._acceptOffer} through
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
    /// @param  offerId            The offer being accepted.
    /// @param  lendingAsset       The ERC-20 principal asset.
    /// @param  lender             The offer's lender (funds the principal + fee).
    /// @param  borrower           The borrowing party (LIF discount + net recipient).
    /// @param  effectivePrincipal The loan principal in lending-asset wei.
    /// @param  isLiquid           Accept-time liquidity of the principal asset.
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
}
