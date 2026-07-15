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
 *        PrecloseFacet.precloseDirect                → initPreclose
 *        PrecloseFacet.transferObligationViaOffer    → initPreclose
 *        PrecloseFacet.offsetWithNewOffer            → initPreclose
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
    function requireLenderNftOwner(LibVaipakam.Loan storage loan) internal view {
        if (IERC721(address(this)).ownerOf(loan.lenderTokenId) != msg.sender)
            revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev Caller must own the borrower-side position NFT for this loan.
    function requireBorrowerNftOwner(LibVaipakam.Loan storage loan) internal view {
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
        uint16 action,
        LibVaipakam.Loan storage loan,
        bool lenderSide
    ) internal view {
        if (msg.sender == address(this)) return;
        uint256 tokenId = lenderSide ? loan.lenderTokenId : loan.borrowerTokenId;
        address nftOwner = IERC721(address(this)).ownerOf(tokenId);
        if (msg.sender == nftOwner) return;
        // #633 — global delegated-keeper pause. The owner short-circuit above
        // means owners can still act on their own positions; only third-party
        // keepers are frozen.
        if (LibVaipakam.cfgKeepersPaused()) {
            revert IVaipakamErrors.KeeperAccessRequired();
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !s.keeperAccessEnabled[nftOwner] ||
            !s.loanKeeperEnabled[loan.id][msg.sender] ||
            (s.approvedKeeperActions[nftOwner][msg.sender] & action) == 0
        ) revert IVaipakamErrors.KeeperAccessRequired();
    }

    /// @notice #393 v1-c — PRE-loan keeper authorization, keyed by the PRINCIPAL
    ///         (the party being acted for) instead of a loan's NFT holder. Used
    ///         by `OfferMatchFacet.matchIntent` to gate a solver filling a
    ///         lender's `requiresKeeperAuth` standing intent: the loan doesn't
    ///         exist yet, so the loan-keyed `requireKeeperFor` can't apply.
    /// @dev    Same model as `requireKeeperFor` minus the per-loan toggle: allow
    ///         the diamond (internal cross-facet), the principal acting for
    ///         themselves, or an opted-in keeper (`keeperAccessEnabled[principal]`
    ///         AND the `action` bit set in `approvedKeeperActions[principal][caller]`).
    /// @param action    One of `LibVaipakam.KEEPER_ACTION_*` (bitmask).
    /// @param principal The party whose authorization is required (the lender).
    function requireKeeperForPrincipal(uint16 action, address principal)
        internal
        view
    {
        if (!isKeeperForPrincipal(msg.sender, action, principal)) {
            revert IVaipakamErrors.KeeperAccessRequired();
        }
    }

    /// @notice Non-reverting twin of {requireKeeperForPrincipal}: reports
    ///         whether `solver` is authorized to act for `principal` on
    ///         `action`, applying the IDENTICAL rules (diamond-internal / self
    ///         exempt, global keeper-pause, per-principal enable + action mask).
    /// @dev    #625 WI-2b — `RiskPreviewFacet.previewIntent` calls this to tell a
    ///         keeper, off-chain, whether a `requiresKeeperAuth` intent is
    ///         fillable BY THAT SOLVER before it spends gas on `matchIntent`
    ///         (which would revert `KeeperAccessRequired`). Reusing the same
    ///         predicate the enforcing path consumes means preview and
    ///         execution can't diverge on authorization.
    function isKeeperForPrincipal(
        address solver,
        uint16 action,
        address principal
    ) internal view returns (bool) {
        if (solver == address(this)) return true; // diamond-internal
        if (solver == principal) return true; // self
        // #633 — global delegated-keeper pause (principal can still self-act).
        if (LibVaipakam.cfgKeepersPaused()) return false;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return
            s.keeperAccessEnabled[principal] &&
            (s.approvedKeeperActions[principal][solver] & action) != 0;
    }

}
