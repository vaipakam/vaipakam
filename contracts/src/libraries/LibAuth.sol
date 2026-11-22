// src/libraries/LibAuth.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibAccessControl} from "./LibAccessControl.sol";
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
 *      NFT holder's `approvedKeeperActions` bitmask. Four actions are
 *      accepted at these six entry points:
 *
 *        EarlyWithdrawalFacet.createLoanSaleOffer    → INIT_EARLY_WITHDRAW
 *        EarlyWithdrawalFacet.completeLoanSale       → COMPLETE_LOAN_SALE
 *        PrecloseFacet.precloseDirect                → initPreclose
 *        PrecloseFacet.transferObligationViaOffer    → initPreclose
 *        PrecloseOffsetFacet.offsetWithNewOffer            → initPreclose
 *        PrecloseOffsetFacet.completeOffset                → COMPLETE_OFFSET
 *
 *      (#3042 retired `RefinanceFacet.refinanceLoan` → REFINANCE: a
 *      refinance now completes only inside the accept of its tagged offer.)
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
/// @dev #3744 — the host of the offer-holder rule (OfferBookFacet).
interface IOfferHolderHost {
    function requireOfferHolder(uint256 offerId, address caller) external view;
}

library LibAuth {
    /// @notice #1638 — the one gate for a `KEEPER_ROLE` entry point: the
    ///         caller holds the role, and the global keeper pause is off.
    /// @dev    Every `KEEPER_ROLE` entry point calls this instead of the bare
    ///         `onlyRole(KEEPER_ROLE)`, so `keepersPaused` freezes them all
    ///         and a new one cannot be added outside the pause. The role is
    ///         checked first, so a non-keeper sees the role error whether or
    ///         not the pause is on.
    function requireActiveKeeper() internal view {
        LibAccessControl.checkRole(LibAccessControl.KEEPER_ROLE, msg.sender);
        if (LibVaipakam.cfgKeepersPaused()) revert IVaipakamErrors.KeepersPaused();
    }

    // ─── #3526 — the manager rule ─────────────────────────────────────────
    //
    // Who may act on a position or a stored party is that account's MANAGER:
    // the account's own wallet, or, once a protected-account replacement
    // retired it, the wallet that replaced it. The retired wallet itself has
    // lost every right. These helpers decide only WHO MAY ACT. The account
    // stays the position's accounting identity, the caller pays with its own
    // funds, and proceeds still go to the account's vault under the protected
    // payout rules: callers keep those four apart.

    // Each gate compares the caller with the manager directly. The manager of
    // the zero address is the zero address, which no caller can be, so an
    // unset party is managed by no one.

    /// @dev Caller must manage the loan's STORED borrower.
    function requireBorrower(LibVaipakam.Loan storage loan) internal view {
        if (msg.sender != LibProtectedAccount.manager(loan.borrower)) revert IVaipakamErrors.NotBorrower();
    }

    /// @dev Caller must manage the loan's STORED lender.
    function requireLender(LibVaipakam.Loan storage loan) internal view {
        if (msg.sender != LibProtectedAccount.manager(loan.lender)) revert IVaipakamErrors.NotLender();
    }

    /// @dev #3744 — the holder of an open offer's position token acts on the
    ///      offer: its terms, its staging, its keepers, its escrow. The offer's
    ///      value follows its token (a fill gives the creator side to the
    ///      token's holder), so the rights to change or withdraw it follow it
    ///      too, and its refunds pay that holder ({LibVaultOutflow.toOfferHolder}).
    ///      The rule has one runtime copy, {OfferBookFacet.requireOfferHolder}
    ///      (see {offerHolderRule}); this is a self-call to it, so a facet near
    ///      EIP-170 carries a call, not the rule.
    function requireOfferHolder(LibVaipakam.Offer storage offer) internal view {
        IOfferHolderHost(address(this)).requireOfferHolder(offer.id, msg.sender);
    }

    /// @dev #3744 — the rule {requireOfferHolder} reaches, run only by its
    ///      host: `caller` is the holder of the offer's token and still manages
    ///      itself (#3526), and the offer's creator still manages itself (a
    ///      retired creator's offer can never be accepted, every open refuses
    ///      a retired account, so the only action left on it is cancelling,
    ///      which {managesOfferHolder} decides).
    function offerHolderRule(LibVaipakam.Offer storage offer, address caller) internal view returns (bool) {
        address holder = LibPositionNFT.holderOrZero(offer.positionTokenId);
        return holder != address(0) && caller == holder && caller == LibProtectedAccount.manager(caller)
            && offer.creator == LibProtectedAccount.manager(offer.creator);
    }

    /// @dev #3744 — whether the caller manages the holder of the offer's
    ///      position token: the holder itself, or its controller once a
    ///      protected-account replacement retired it. The cancel right.
    function managesOfferHolder(LibVaipakam.Offer storage offer) internal view returns (bool) {
        address holder = LibPositionNFT.holderOrZero(offer.positionTokenId);
        return holder != address(0) && msg.sender == LibProtectedAccount.manager(holder);
    }

    /// @dev Caller must manage the holder of the loan's lender-side position.
    function requireLenderNftOwner(LibVaipakam.Loan storage loan) internal view {
        requirePositionManager(loan.lenderTokenId);
    }

    /// @dev Caller must manage the holder of the loan's borrower-side position.
    function requireBorrowerNftOwner(LibVaipakam.Loan storage loan) internal view {
        requirePositionManager(loan.borrowerTokenId);
    }

    /// @dev Caller must MANAGE the `tokenId` position NFT's holder: the holder
    ///      itself, or its controller once a protected-account replacement
    ///      retired it. Reverts for a position that was never minted.
    function requirePositionManager(uint256 tokenId) internal view {
        if (msg.sender != LibProtectedAccount.manager(LibPositionNFT.ownerOf(tokenId))) revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev #3526 — the self-dealing exclusion on a repayment: the caller may
    ///      not be the loan's lender side, by its stored party, by the lender
    ///      position's holder, or as the manager of either (so a controller
    ///      managing both sides is still excluded).
    function requireNotLenderSide(LibVaipakam.Loan storage loan) internal view {
        requireNotLenderSide(loan, msg.sender);
    }

    /// @dev The same rule for a named payer: a repayment drawn from a
    ///      standing-instruction reserve (#3681) is paid by the reserve's
    ///      holder, not by the Diamond that made the call.
    function requireNotLenderSide(LibVaipakam.Loan storage loan, address payer) internal view {
        if (payer == loan.lender || payer == LibProtectedAccount.manager(loan.lender)) revert IVaipakamErrors.LenderCannotRepayOwnLoan();
        address holder = LibPositionNFT.ownerOf(loan.lenderTokenId);
        if (payer == holder || payer == LibProtectedAccount.manager(holder)) revert IVaipakamErrors.LenderCannotRepayOwnLoan();
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
    ) internal view returns (bool keeperActed) {
        // #1219 (S-4) — reports whether a KEEPER acted (true) rather than the
        // position's owner or the Diamond itself (false): the capacity limiter
        // charges a keeper's action, never an owner acting on their own position.
        if (msg.sender == address(this)) return false;
        uint256 tokenId = lenderSide ? loan.lenderTokenId : loan.borrowerTokenId;
        address nftOwner = LibPositionNFT.ownerOf(tokenId);
        // Protected account mode: the holder acts through its manager. Once
        // a replacement retired the holder, its controller acts on the
        // position and the old wallet is no longer the owner here; no keeper
        // grant it made survives ({keeperMayActFor}).
        if (msg.sender == LibProtectedAccount.manager(nftOwner)) return false;
        if (!keeperMayActFor(msg.sender, action, loan.id, nftOwner)) {
            revert IVaipakamErrors.KeeperAccessRequired();
        }
        return true;
    }

    /// @notice Whether `keeper`, which is neither the Diamond nor the position's
    ///         holder, may take `action` on loan `loanId` for `nftOwner`.
    /// @dev    The keeper half of {requireKeeperFor}, factored out (#1841) so the
    ///         sale-exit verdict (`SaleExitVerdictFacet`) classifies a keeper
    ///         caller by the same rule the entry enforces. #633 — the global
    ///         delegated-keeper pause refuses every third-party keeper; owners
    ///         acting on their own positions never reach this.
    function keeperMayActFor(
        address keeper,
        uint16 action,
        uint256 loanId,
        address nftOwner
    ) internal view returns (bool) {
        if (LibVaipakam.cfgKeepersPaused()) return false;
        // A replacement voids every keeper grant the retired holder made.
        if (LibProtectedAccount.manager(nftOwner) != nftOwner) return false;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.keeperAccessEnabled[nftOwner] &&
            s.loanKeeperEnabled[loanId][keeper] &&
            (s.approvedKeeperActions[nftOwner][keeper] & action) != 0;
    }

    /// @notice #393 v1-c — PRE-loan keeper authorization, keyed by the PRINCIPAL
    ///         (the party being acted for) instead of a loan's NFT holder. Used
    ///         by `OfferMatchIntentFacet.matchIntent` to gate a solver filling a
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
        returns (bool keeperActed)
    {
        if (!isKeeperForPrincipal(msg.sender, action, principal)) {
            revert IVaipakamErrors.KeeperAccessRequired();
        }
        // #1219 (S-4) — true only when a KEEPER acted for the principal.
        return msg.sender != principal && msg.sender != address(this);
    }

    /// @notice Non-reverting twin of {requireKeeperForPrincipal}: reports
    ///         whether `solver` is authorized to act for `principal` on
    ///         `action`, applying the IDENTICAL rules (diamond-internal / self
    ///         exempt, global keeper-pause, per-principal enable + action mask).
    /// @dev    #625 WI-2b — `IntentPreviewFacet.previewIntent` calls this to tell a
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
        // Protected account mode: a replaced (retired) account acts only
        // through its controller. Its old wallet is no longer "self", and no
        // keeper grant it made survives the replacement.
        address mgr = LibProtectedAccount.manager(principal);
        if (solver == mgr) return true; // self, or the controller
        if (mgr != principal) return false;
        // #633 — global delegated-keeper pause (principal can still self-act).
        if (LibVaipakam.cfgKeepersPaused()) return false;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return
            s.keeperAccessEnabled[principal] &&
            (s.approvedKeeperActions[principal][solver] & action) != 0;
    }

}
