// src/libraries/LibLoan.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRevert} from "./LibRevert.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";

/// @title LibLoan
/// @notice Shared helpers for mid-life loan mutations. Consolidates the
///         burn-old / mint-new NFT migration pattern used when a loan's
///         lender or borrower is replaced (loan-sale, obligation-transfer).
///         Keeps `nextTokenId` bumps, status labels, and token-id
///         assignments in lockstep with the NFT facet so no facet can
///         drift out of sync as metadata evolves in Phase 2.
library LibLoan {
    /// @dev Replaces the lender on an existing loan: burns the current
    ///      lender NFT, mints a fresh LoanInitiated NFT to `newLender`,
    ///      and updates both `loan.lender` and `loan.lenderTokenId`.
    ///      Callers must already have validated authorization, compliance,
    ///      and lender-favorability constraints.
    function migrateLenderPosition(
        uint256 loanId,
        address newLender
    ) internal returns (uint256 newTokenId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #998 S10 Class B — migrate the DEDICATED active-held reservation to
        // `newLender` BEFORE re-anchoring `loan.lender` below (it reads the old
        // lender from the live loan). Centralised here so EVERY lender-position
        // sale path carries the reservation with the held it moves, without each
        // caller remembering to. No-op when nothing was parked. (Consolidation
        // does not route through here; it migrates via `rekeyLienToHolder`.)
        LibEncumbrance.migrateActiveHeld(loanId, newLender);
        address diamond = address(this);

        (bool success, bytes memory data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                loan.lenderTokenId
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTBurnFailed.selector);

        unchecked {
            newTokenId = ++s.nextTokenId;
        }

        (success, data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                newLender,
                newTokenId,
                loan.offerId,
                loanId,
                true, // isLender
                LibVaipakam.LoanPositionStatus.LoanInitiated
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTMintFailed.selector);

        loan.lender = newLender;
        loan.lenderTokenId = newTokenId;
    }

    /// @dev Replaces the borrower on an existing loan. Symmetric to
    ///      {migrateLenderPosition}: burns the current borrower NFT,
    ///      mints a fresh LoanInitiated NFT to `newBorrower`, and updates
    ///      both `loan.borrower` and `loan.borrowerTokenId`.
    function migrateBorrowerPosition(
        uint256 loanId,
        address newBorrower
    ) internal returns (uint256 newTokenId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address diamond = address(this);

        (bool success, bytes memory data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                loan.borrowerTokenId
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTBurnFailed.selector);

        unchecked {
            newTokenId = ++s.nextTokenId;
        }

        (success, data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                newBorrower,
                newTokenId,
                loan.offerId,
                loanId,
                false, // isLender = false (borrower)
                LibVaipakam.LoanPositionStatus.LoanInitiated
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTMintFailed.selector);

        loan.borrower = newBorrower;
        loan.borrowerTokenId = newTokenId;
    }
}
