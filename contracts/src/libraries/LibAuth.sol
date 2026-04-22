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
 *      ── Keeper-accessible surface (exhaustive) ─────────────────────────────
 *      Only two external functions accept keeper callers; everything else is
 *      strictly role-scoped. Expanding this list is a protocol-policy change
 *      and MUST be reviewed against README section 3:
 *
 *        1. EarlyWithdrawalFacet.completeLoanSale  → requireLenderNFTOwnerOrKeeper
 *           (lender-entitled; authority follows ownerOf(lenderTokenId); keeper
 *           must be whitelisted by the current lender-NFT holder)
 *        2. PrecloseFacet.completeOffset           → requireBorrowerNFTOwnerOrKeeper
 *           (borrower-entitled; authority follows ownerOf(borrowerTokenId);
 *           keeper must be whitelisted by the current borrower-NFT holder)
 *
 *      Per README §3 lines 190–191, ownership-sensitive authority resolves
 *      against the current `ownerOf(tokenId)` — not the latched
 *      `loan.lender` / `loan.borrower` — so a mid-flow NFT transfer carries
 *      authority with the NFT. All other loan-mutating functions (repay,
 *      claim, addCollateral, precloseDirect, partialWithdraw, refinance,
 *      createOffer, acceptOffer, liquidate, markDefaulted, …) explicitly
 *      reject keepers.
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

    /// @dev Permit the current owner of the borrower-side position NFT, the
    ///      diamond itself (internal cross-facet), or a keeper scoped to the
    ///      current NFT owner. Use for borrower-entitled strategic-flow
    ///      completion paths (Preclose Option 3 offset completion, etc.).
    ///
    ///      Bound to `ownerOf(loan.borrowerTokenId)` rather than
    ///      `loan.borrower` so a mid-flow NFT transfer (e.g. secondary sale
    ///      of a borrower position) correctly carries authority with the
    ///      NFT. Keeper whitelist is also resolved against the current NFT
    ///      owner, not the latched loan.borrower.
    function requireBorrowerNFTOwnerOrKeeper(LibVaipakam.Loan storage loan) internal view {
        if (msg.sender == address(this)) return;
        address nftOwner = IERC721(address(this)).ownerOf(loan.borrowerTokenId);
        if (msg.sender == nftOwner) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !loan.borrowerKeeperAccessEnabled ||
            !s.keeperAccessEnabled[nftOwner] ||
            !s.approvedKeepers[nftOwner][msg.sender]
        ) revert IVaipakamErrors.KeeperAccessRequired();
    }

    /// @dev Permit the current owner of the lender-side position NFT, the
    ///      diamond itself, or a keeper scoped to the current NFT owner.
    ///      Use for lender-entitled strategic-flow completion paths
    ///      (EarlyWithdrawal completeLoanSale).
    function requireLenderNFTOwnerOrKeeper(LibVaipakam.Loan storage loan) internal view {
        if (msg.sender == address(this)) return;
        address nftOwner = IERC721(address(this)).ownerOf(loan.lenderTokenId);
        if (msg.sender == nftOwner) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !loan.lenderKeeperAccessEnabled ||
            !s.keeperAccessEnabled[nftOwner] ||
            !s.approvedKeepers[nftOwner][msg.sender]
        ) revert IVaipakamErrors.KeeperAccessRequired();
    }

}
