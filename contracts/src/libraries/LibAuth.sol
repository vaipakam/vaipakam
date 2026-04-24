// src/libraries/LibAuth.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title LibAuth
 * @notice Centralizes authorization checks reused across facets.
 * @dev Internal library — inlined into calling facet, so `address(this)` is the
 *      diamond. All shared errors live in IVaipakamErrors; this library only
 *      enforces the checks.
 *
 *      Keeper policy mirrors README section 3 lines 176–179: keeper authority
 *      is role-scoped to the party whose action the keeper is executing on
 *      behalf of. Lender and borrower may always act; internal diamond calls
 *      (msg.sender == address(this)) are always allowed.
 *
 *      ── Keeper-accessible surface (Phase 6) ────────────────────────────────
 *      Keeper authority is gated per-action via
 *      {requireKeeperFor(action, loan, lenderSide)} against the relevant
 *      NFT holder's `approvedKeeperActions` bitmask. Five actions are
 *      accepted at these seven entry points:
 *
 *        EarlyWithdrawalFacet.createLoanSaleOffer    → INIT_EARLY_WITHDRAW
 *        EarlyWithdrawalFacet.completeLoanSale       → COMPLETE_LOAN_SALE
 *        PrecloseFacet.precloseDirect                → INIT_PRECLOSE
 *        PrecloseFacet.transferObligationViaOffer    → INIT_PRECLOSE
 *        PrecloseFacet.offsetWithNewOffer            → INIT_PRECLOSE
 *        PrecloseFacet.completeOffset                → COMPLETE_OFFSET
 *        RefinanceFacet.refinanceLoan                → REFINANCE
 *
 *      Money-out operations (repay, claim, addCollateral,
 *      partialWithdraw, acceptOffer, liquidate, triggerDefault)
 *      explicitly reject keepers — user-only actions by design.
 *
 *      Per README §3 lines 190–191, NFT-owner authority resolves against
 *      `ownerOf(tokenId)` — not the latched `loan.lender` /
 *      `loan.borrower` — so a mid-flow NFT transfer carries authority
 *      with the NFT, and keeper whitelist is also resolved against the
 *      current NFT holder.
 */
library LibAuth {
    function requireBorrower(LibVaipakam.Loan storage loan) internal view {
        if (loan.borrower != msg.sender) revert IVaipakamErrors.NotBorrower();
    }

    function requireLender(LibVaipakam.Loan storage loan) internal view {
        if (loan.lender != msg.sender) revert IVaipakamErrors.NotLender();
    }

    function requireOfferCreator(LibVaipakam.Offer storage offer) internal view {
        if (offer.creator != msg.sender) revert IVaipakamErrors.NotOfferCreator();
    }

    /// @dev Caller must own the lender-side position NFT for this loan.
    function requireLenderNFTOwner(LibVaipakam.Loan storage loan) internal view {
        if (IERC721(address(this)).ownerOf(loan.lenderTokenId) != msg.sender)
            revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev Caller must own the borrower-side position NFT for this loan.
    function requireBorrowerNFTOwner(LibVaipakam.Loan storage loan) internal view {
        if (IERC721(address(this)).ownerOf(loan.borrowerTokenId) != msg.sender)
            revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev Canonical keeper-authorization helper (Phase 6).
    ///
    ///      Permits three callers for a keeper-accessible function:
    ///        1. The Diamond itself (internal cross-facet calls).
    ///        2. The current owner of the relevant-side Vaipakam position NFT
    ///           — `lenderTokenId` if `lenderSide` is true, `borrowerTokenId`
    ///           otherwise.
    ///        3. An address scoped to the current NFT owner's whitelist AND
    ///           enabled for this specific loan AND authorised for this
    ///           specific `action` (bitmask check against
    ///           `approvedKeeperActions`).
    ///
    ///      Failure on any of the three gates (master switch off, per-loan
    ///      flag off, action bit clear) reverts with {KeeperAccessRequired}.
    ///
    ///      NFT-owner authority is bound to `ownerOf(tokenId)` rather than
    ///      `loan.lender` / `loan.borrower` so a mid-flow NFT transfer
    ///      correctly carries authority with the position. Keeper whitelist
    ///      is also resolved against the current NFT owner.
    ///
    /// @param action     One of `LibVaipakam.KEEPER_ACTION_*` (bitmask).
    /// @param loan       Loan storage ref being acted on.
    /// @param lenderSide True to authorise against the lender NFT, false for
    ///                   the borrower NFT.
    function requireKeeperFor(
        uint8 action,
        LibVaipakam.Loan storage loan,
        bool lenderSide
    ) internal view {
        if (msg.sender == address(this)) return;
        uint256 tokenId = lenderSide ? loan.lenderTokenId : loan.borrowerTokenId;
        address nftOwner = IERC721(address(this)).ownerOf(tokenId);
        if (msg.sender == nftOwner) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !s.keeperAccessEnabled[nftOwner] ||
            !s.loanKeeperEnabled[loan.id][msg.sender] ||
            (s.approvedKeeperActions[nftOwner][msg.sender] & action) == 0
        ) revert IVaipakamErrors.KeeperAccessRequired();
    }

}
