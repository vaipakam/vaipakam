// src/libraries/LibLenderSide.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibInterestLedger} from "./LibInterestLedger.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibAdvance} from "./LibAdvance.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ILenderSideHost} from "../interfaces/ILenderSideHost.sol";

/**
 * @title  LibLenderSide
 * @author Vaipakam Developer Team
 * @notice #3760 — the ONE writer of the two stores a loan's lender side
 *         receives into (LenderCashOutDesign §6.4):
 *         - `heldForLender[loanId]`: what arrives while the loan is open (a
 *           part repayment, interest, an early-close top-up, a matched
 *           liquidation's proceeds, a sale's held balance), and
 *         - `lenderClaims[loanId]`: the final claim the loan's end writes (the
 *           final repayment, a refinance payoff, a default, a liquidation or
 *           a fallback).
 *         Every step that adds to or takes from either store calls this
 *         library; `contracts/script/check-lender-side-writer.mjs` (pre-deploy
 *         step 1d5) refuses a write to either store anywhere else, additions
 *         and subtractions alike. Reads stay open.
 *
 *         While an advance is open on the loan, everything that arrives pays
 *         the advance's interest, then the advance, and only then the holder.
 *         The order lives in one place, `LenderSideFacet`, which this library
 *         reaches by a self-call only while an advance is open; no caller
 *         passes an order in. Booking happens at ARRIVAL, in the step that
 *         adds to a store, so interest on the advance stops on each amount the
 *         moment it arrives, whoever moves it later. The host never reverts
 *         inside a borrower's route: a flagged or replaced slot owner, or an
 *         arrival smaller than what is owed, is booked for what it is.
 *
 *         So a store holds only the HOLDER's part: what the advance took is
 *         set aside in the same vault under the advance's own lien
 *         (`LibEncumbrance.lienAdvanceSetAside`), and a taker of either store
 *         can never reach it.
 * @dev    Inlined into every adder and taker. A loan without an open advance
 *         (every loan but the few with one) takes the plain write and never
 *         reaches the host, so the common path costs one storage read more
 *         than before.
 */
library LibLenderSide {
    // ─── The held store (open loan) ──────────────────────────────────────

    /**
     * @notice `amount` of `asset` arrived in the stored lender's vault for
     *         `loanId`'s lender position while the loan is open. Books the
     *         advance's part (if one is open) and adds the rest to the held
     *         store.
     * @return kept What the held store received: the holder's part. The
     *         caller reserves exactly this under the active-held reservation;
     *         the advance's part is reserved by the host under its own lien.
     */
    function addHeld(LibVaipakam.Storage storage s, uint256 loanId, address asset, uint256 amount)
        internal
        returns (uint256 kept)
    {
        if (amount == 0) return 0;
        kept = amount;
        if (s.advances[loanId].open) {
            kept = amount - _call(abi.encodeCall(ILenderSideHost.bookArrival, (loanId, asset, amount)));
        }
        if (kept != 0) s.heldForLender[loanId] += kept;
    }

    /**
     * @notice Takes everything held for `loan`'s lender position off the
     *         books and returns what it was and in which asset, so it can
     *         leave: to the position holder's vault (`claimHeldForLender`), or
     *         back behind the owner's standing intent (the roll and
     *         `recommitHeldToIntent`). The caller moves the funds; this only
     *         settles the records, so every taker settles them the same way.
     *         No-op (0) when nothing is held.
     * @dev    In order: a recorded fail-closed claimant must read clean and its
     *         marker is cleared; the active-held reservation and, on an open
     *         loan, the lender-proceeds reservation (which there carries only
     *         the VPFI part of a held balance a sale credited, #597) are
     *         released; the interest ledger's parked interest is reported to
     *         the holder as paid and cleared, so a later sale cannot turn
     *         interest the holder already took into a seller claim; the held
     *         ledger is zeroed; the loan's positions are marked (value out).
     *         What an advance took was never in this store, and its lien is
     *         not touched.
     */
    function takeHeld(LibVaipakam.Storage storage s, uint256 loanId, LibVaipakam.Loan storage loan)
        internal
        returns (uint256 amount, address asset)
    {
        // The advance is paid first: what is set aside for it moves to the
        // slot owner here, inside the holder's own step (§6.4).
        if (LibAdvance.hasSetAside(s, loanId)) _call(abi.encodeCall(ILenderSideHost.settleAtTake, (loanId, false)));
        amount = s.heldForLender[loanId];
        if (amount == 0) return (0, address(0));
        asset = loan.assetType == LibVaipakam.AssetType.ERC20 ? loan.principalAsset : loan.prepayAsset;
        address frozen = LibSanctionedLock.frozenClaimant(s, loanId, true);
        if (frozen != address(0)) {
            LibVaipakam.assertNotSanctionedFailClosed(frozen);
            LibSanctionedLock.clearConfirmedFlag(s, frozen);
            LibSanctionedLock.clearFrozenClaimant(s, loanId, true);
        }
        LibEncumbrance.releaseActiveHeld(loanId, loan.lender);
        if (loan.status == LibVaipakam.LoanStatus.Active) {
            LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);
        }
        LibVaipakam.InterestLedger storage l = s.interestLedger[loanId];
        if (l.parkedInterestGross != 0 || l.parkedInterestNet != 0) {
            LibInterestLedger.holderPaid(s, loan, l.parkedInterestGross);
            l.parkedInterestGross = 0;
            l.parkedInterestNet = 0;
            l.parkedInterestReservedNet = 0;
        }
        s.heldForLender[loanId] = 0;
        // #3413 / #3710 — what was held for the lender position left it (a
        // claim, a recommit to an intent): marked here, the one taker.
        LibPositionNFT.markLoanValueOut(loanId);
    }

    /// @notice `amount` of the held store left for a prior seller of the
    ///         position (`SellerClaimFacet`). Never more than is held.
    function subHeld(LibVaipakam.Storage storage s, uint256 loanId, uint256 amount) internal {
        uint256 held = s.heldForLender[loanId];
        s.heldForLender[loanId] = amount < held ? held - amount : 0;
    }

    /// @notice The held store moved with the position to its holder's vault
    ///         and the vault received `credited`, less than was sent (a token
    ///         that charges its sender): the store follows what arrived.
    function capHeld(LibVaipakam.Storage storage s, uint256 loanId, uint256 credited) internal {
        if (credited < s.heldForLender[loanId]) s.heldForLender[loanId] = credited;
    }

    // ─── The final claim (loan ended) ────────────────────────────────────

    /**
     * @notice Write `loanId`'s final lender claim. `row.amount` is the whole
     *         of what the lender side receives at the loan's end; while an
     *         advance is open the host books its part and the row keeps the
     *         holder's.
     * @return kept The holder's part the row now names: the amount a caller
     *         that reserves the proceeds reserves.
     */
    function setFinal(LibVaipakam.Storage storage s, uint256 loanId, LibVaipakam.ClaimInfo memory row)
        internal
        returns (uint256 kept)
    {
        s.lenderClaims[loanId] = row;
        kept = row.amount;
        if (_hosted(s, loanId)) kept = _call(abi.encodeCall(ILenderSideHost.bookFinal, (loanId, kept, false)));
    }

    /**
     * @notice The final claim's whole amount is now `amount` (what reached the
     *         lender side's vault: a parked leg released, a custody slice
     *         reduced, a match that consumed the slice).
     * @return kept The holder's part the row now names.
     */
    function setFinalAmount(LibVaipakam.Storage storage s, uint256 loanId, uint256 amount)
        internal
        returns (uint256 kept)
    {
        if (_hosted(s, loanId)) return _call(abi.encodeCall(ILenderSideHost.bookFinal, (loanId, amount, false)));
        s.lenderClaims[loanId].amount = amount;
        return amount;
    }

    /**
     * @notice A fallback loan's lender slice, `amount` of the collateral in
     *         kind, reached the stored lender's vault after the one retry of
     *         the failed sale did not sell (LenderCashOutDesign §6.6). An open
     *         advance takes collateral worth what it is owed at the rate the
     *         fallback itself used (all of it where the fallback had no
     *         price); the row keeps the rest.
     */
    function settleFinalInKind(LibVaipakam.Storage storage s, uint256 loanId, uint256 amount)
        internal
        returns (uint256 kept)
    {
        if (_hosted(s, loanId)) return _call(abi.encodeCall(ILenderSideHost.bookFinal, (loanId, amount, true)));
        s.lenderClaims[loanId].amount = amount;
        return amount;
    }

    /// @notice The final claim is consumed (paid, rolled, or bought out):
    ///         everything the lender side will receive has arrived. An advance
    ///         still open closes, any part unpaid stated as its shortfall, and
    ///         what is set aside for it moves to the slot owner first.
    function markFinalClaimed(LibVaipakam.Storage storage s, uint256 loanId) internal {
        if (s.advances[loanId].open || LibAdvance.hasSetAside(s, loanId)) {
            _call(abi.encodeCall(ILenderSideHost.settleAtTake, (loanId, true)));
        }
        s.lenderClaims[loanId].claimed = true;
    }

    /**
     * @notice The backstop's cash for `loanId`'s lender slice, `amount` of
     *         the lending asset from `fromOwner`'s vault, is the slice's arrival: an open
     *         advance takes its part first (moved into the stored lender's
     *         vault and set aside), and the holder is paid the rest.
     * @return toAdvance What went to the advance (0 when none is open).
     */
    function absorbAdvance(LibVaipakam.Storage storage s, uint256 loanId, address fromOwner, uint256 amount)
        internal
        returns (uint256 toAdvance)
    {
        if (!s.advances[loanId].open) return 0;
        toAdvance = _call(abi.encodeCall(ILenderSideHost.absorbArrival, (loanId, fromOwner, amount)));
    }

    /// @notice `amount` of the final claim left for a prior seller of the
    ///         position (`SellerClaimFacet`).
    function subFinal(LibVaipakam.Storage storage s, uint256 loanId, uint256 amount) internal {
        s.lenderClaims[loanId].amount -= amount;
    }

    /// @notice The final claim no longer stands: a fallback was cured and the
    ///         loan is open again. Nothing in it was ever booked to an advance
    ///         (a fallback's in-kind row waits for the claim).
    function clearFinal(LibVaipakam.Storage storage s, uint256 loanId) internal {
        delete s.lenderClaims[loanId];
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev The host is reached while an advance is open, or while a final
    ///      row it booked can still change.
    function _hosted(LibVaipakam.Storage storage s, uint256 loanId) private view returns (bool) {
        LibVaipakam.Advance storage a = s.advances[loanId];
        return a.open || a.finalBooked != 0;
    }

    /// @dev The one self-call to the host, shared by every entry above;
    ///      answers the host's one word (0 for an entry that answers none).
    function _call(bytes memory data) private returns (uint256 r) {
        bytes memory ret = LibFacet.crossFacetCallReturn(data, IVaipakamErrors.CrossFacetCallFailed.selector);
        if (ret.length >= 32) r = abi.decode(ret, (uint256));
    }
}
