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
 *        PrecloseFacet.offsetWithNewOffer            → initPreclose
 *        PrecloseFacet.completeOffset                → COMPLETE_OFFSET
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
        if (LibPositionNFT.ownerOf(loan.lenderTokenId) != msg.sender)
            revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev Caller must own the borrower-side position NFT for this loan.
    function requireBorrowerNftOwner(LibVaipakam.Loan storage loan) internal view {
        if (LibPositionNFT.ownerOf(loan.borrowerTokenId) != msg.sender)
            revert IVaipakamErrors.NotNFTOwner();
    }

    /// @dev Caller must MANAGE the `tokenId` position NFT's holder: the holder
    ///      itself, or its controller once a protected-account replacement
    ///      retired it. The rule for a holder's standing CONSENT (auto-extend
    ///      caps), which a retired wallet must not be able to give.
    function requirePositionManager(uint256 tokenId) internal view {
        if (msg.sender != LibProtectedAccount.manager(LibPositionNFT.ownerOf(tokenId)))
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
