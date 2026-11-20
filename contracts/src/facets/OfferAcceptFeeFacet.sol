// src/facets/OfferAcceptFeeFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibFeeEntitlement} from "../libraries/LibFeeEntitlement.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibFeeFloor} from "../libraries/LibFeeFloor.sol";
import {LibFeeShares} from "../libraries/LibFeeShares.sol";
import {LibIntegrator} from "../libraries/LibIntegrator.sol";
import {LibReferral} from "../libraries/LibReferral.sol";
import {IntegratorFacet} from "./IntegratorFacet.sol";
import {ReferralFacet} from "./ReferralFacet.sol";
import {ITreasuryFeeHost} from "../interfaces/ITreasuryFeeHost.sol";
import {LibRefinanceNetting} from "../libraries/LibRefinanceNetting.sol";
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
    ///         lender's funded principal split treasury/matcher (the
    ///         matcher's share sized above the treasury floor, #3649), and
    ///         delivers `principal − fee` to the borrower — except on a
    ///         refinance accept, where it parks that amount in the new
    ///         lender's vault for the payoff instead (#3042,
    ///         {LibRefinanceNetting}). Matcher resolves to
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
                : LibFeeEntitlement.offerFullConsented(offerId, borrower),
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
        // #3722 — the fee after the hold discount and the borrower's
        // referral, by the one rule every borrow preview reads.
        LibReferral.Quote memory q = LibReferral.quote(
            borrower,
            effectivePrincipal,
            offer.durationDays, // #3649 — the accepted offer's term is the loan's
            isLiquid,
            borrowerFull
        );
        uint256 initiationFee = q.fee;

        if (initiationFee > 0) {
            _chargeFee(
                ChargeCtx({
                    offerId: offerId,
                    lendingAsset: lendingAsset,
                    lender: lender,
                    borrower: borrower,
                    principal: effectivePrincipal,
                    fee: initiationFee,
                    above: q.above,
                    cut: q.cut,
                    share: q.share,
                    inviter: q.inviter,
                    // #3682 — the integrator the BORROWER named: from its signed
                    // accept terms when it accepts a lender's offer, else from
                    // its own offer. A lender's action never names one.
                    integrator: isLenderOffer
                        ? (s.acceptAckActive ? s.acceptAckIntegrator : address(0))
                        : offer.integrator,
                    matcher: s.matchOverride.active
                        ? s.matchOverride.matcher
                        : (s.signedOfferAcceptor != address(0) ? s.signedOfferAcceptor : originalCaller)
                })
            );
        }

        // #3042 — a refinance accept does not deliver: the net principal stays
        // in the new lender's vault and pays the old loan's payoff directly,
        // in this same transaction (`RefinanceFacet` takes the record parked
        // here). Same predicate as the chain into `RefinanceFacet`, so a park
        // is always consumed or the accept reverts.
        if (LibRefinanceNetting.isRefinanceAccept(offer)) {
            LibRefinanceNetting.park(
                offerId,
                lender,
                lendingAsset,
                effectivePrincipal - initiationFee
            );
            return;
        }

        // Deliver the net principal (principal − fee) to the borrower. #2440 —
        // the loan records the borrower as owing all of `effectivePrincipal`,
        // so the net principal must arrive in full: a lending asset that
        // delivers less than it sends is refused at acceptance, as the
        // collateral is (the platform does not support such tokens).
        // #3205 part 2 — into the borrower's VAULT (owner decision: protocol
        // payouts go to the payee's vault), from which the borrower withdraws.
        LibDelivery.requireFull(
            lendingAsset,
            effectivePrincipal - initiationFee,
            LibVaultOutflow.toBorrowerAtAccept(lender, lendingAsset, effectivePrincipal - initiationFee, offerId)
        );
    }

    /// @dev The inputs of one initiation-fee charge, in a struct so the split
    ///      runs in its own frame.
    struct ChargeCtx {
        uint256 offerId;
        address lendingAsset;
        address lender;
        address borrower;
        uint256 principal;
        uint256 fee;
        uint256 above;
        uint256 cut;
        uint256 share;
        address inviter;
        address integrator;
        /// @dev Zero only for a match that names no matcher (the instant
        ///      market's own borrow, #3656): no match share is paid.
        address matcher;
    }

    /// @notice #3682 — the integrator named on an accept, and what became of
    ///         its share of the initiation fee. `amount` is the share after
    ///         the per-loan ceiling; `delivered` says whether it reached the
    ///         integrator's vault. A refused integrator (`refusal` other than
    ///         None) is paid nothing, and a share that could not be delivered
    ///         went to the reserve in the same transaction. The loan opened
    ///         either way: `loanId` is the loan this accept of `offerId`
    ///         created, whose `LoanInitiatedDetails` names the same
    ///         integrator (the loan's creation refuses any other id).
    event IntegratorShareSettled(
        uint256 indexed loanId,
        address indexed integrator,
        address indexed asset,
        uint256 offerId,
        uint256 amount,
        bool delivered,
        LibIntegrator.Refusal refusal
    );

    /// @notice #3722 — a loan opened by `newUser` inside its referral
    ///         period: `cut` is the part of the initiation fee not charged,
    ///         `share` the inviter's share after the per-loan ceiling, and
    ///         `outcome` where the share went (to `inviter`'s wallet, or to
    ///         the reserve and why). The loan opened either way: `loanId` is
    ///         the loan this accept of `offerId` created.
    event ReferralShareSettled(
        uint256 indexed loanId,
        address indexed newUser,
        address indexed inviter,
        address asset,
        uint256 offerId,
        uint256 cut,
        uint256 share,
        LibReferral.Outcome outcome
    );

    /// @dev Divide the fee: the treasury's floor first (taken by the
    ///      treasury leg's split), then from the part above it the matcher's
    ///      share at its rate (the settings keep it and the cut under the
    ///      ceiling), then the integrator's and the inviter's shares under
    ///      the per-loan ceiling, after the borrower's referral cut, which
    ///      was never charged ({LibFeeShares}); the rest of the fee is the treasury
    ///      leg, whose part above the floor is the reserve's. The
    ///      integrator's and the inviter's shares are each paid as one
    ///      isolated step that may fail alone: a failure or a short delivery
    ///      is undone and the share joins the treasury leg, above the floor,
    ///      so it is the reserve's.
    function _chargeFee(ChargeCtx memory c) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.acceptIntegratorPending = c.integrator;
        // The loan this accept creates takes the next id; the loan's creation
        // checks it, so this event joins exactly one loan on every route.
        uint256 loanId = s.nextLoanId + 1;
        s.acceptChargeLoanId = loanId;
        (uint256 rateBps, LibIntegrator.Refusal refusal) = LibIntegrator.rateFor(c.integrator, c.borrower);
        // Instant market (#3656) — a match that names no matcher (the
        // borrower's own instant borrow) pays no match share; that part stays
        // in the treasury leg, above the floor, so it is the reserve's.
        uint256 matcherCut = c.matcher == address(0) ? 0 : LibOfferMatch.matcherShareOf(c.above);
        (uint256 integratorCut, uint256 share) = LibFeeShares.bound(
            c.above, c.cut, matcherCut, (c.above * rateBps) / LibVaipakam.BASIS_POINTS, c.share
        );

        bool delivered;
        if (integratorCut > 0) {
            (delivered,) = address(this).call(
                abi.encodeCall(
                    IntegratorFacet.deliverIntegratorShare,
                    (c.lender, c.lendingAsset, integratorCut, c.integrator, c.offerId)
                )
            );
        }
        if (c.integrator != address(0)) {
            emit IntegratorShareSettled(loanId, c.integrator, c.lendingAsset, c.offerId, integratorCut, delivered, refusal);
        }

        // #2440 — the treasury accrues what reached it; the host splits it at
        // the floor, so an undelivered integrator share is the reserve's.
        LibFacet.vaultFeeToTreasury(
            c.lender,
            c.lendingAsset,
            c.fee - matcherCut - (delivered ? integratorCut : 0) - _settleReferral(c, loanId, share),
            LibFeeFloor.initiation(c.principal)
        );
        if (matcherCut > 0) {
            LibVaultOutflow.toIncentive(
                c.lender, c.lendingAsset, matcherCut, c.matcher, c.offerId, OutflowReason.INCENTIVE
            );
        }
    }

    /// @dev #3722 — pay the inviter's `share` (after the ceiling) as one
    ///      isolated step, state where it went, and count the loan. Returns
    ///      what reached the inviter (0 when the share went to the reserve).
    function _settleReferral(ChargeCtx memory c, uint256 loanId, uint256 share) private returns (uint256 paid) {
        if (c.inviter == address(0) || (c.cut == 0 && share == 0)) return 0;
        LibReferral.Outcome outcome = LibReferral.Outcome.NoShare;
        if (share > 0) {
            (bool ok, bytes memory ret) = address(this).call(
                abi.encodeCall(ReferralFacet.payReferralShare, (c.lender, c.lendingAsset, share, c.borrower, c.offerId))
            );
            if (ok) {
                outcome = LibReferral.Outcome.Paid;
                paid = share;
            } else {
                bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
                outcome = sel == LibVaipakam.SanctionedAddress.selector
                    ? LibReferral.Outcome.InviterFlagged
                    : (sel == TokenDeliveryShort.selector
                        ? LibReferral.Outcome.DeliveredShort
                        : LibReferral.Outcome.PaymentFailed);
            }
        }
        LibVaipakam.ReferralTotals storage t = LibVaipakam.storageSlot().referralTotals[c.lendingAsset];
        t.cut += c.cut;
        t.sharePaid += paid;
        t.shareRedirected += share - paid;
        t.loans += 1;
        emit ReferralShareSettled(loanId, c.borrower, c.inviter, c.lendingAsset, c.offerId, c.cut, share, outcome);
    }
}
