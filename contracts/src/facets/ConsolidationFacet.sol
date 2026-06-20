// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title ConsolidationFacet
 * @author Vaipakam Developer Team
 * @notice #594 — the **standalone** entry points for consolidating a
 *         transferred loan position into the current NFT holder's vault. Both
 *         are **holder-only** (not keeper-callable — the keeper-action mask is
 *         full, so keeper-driven consolidation rides the eager hooks under each
 *         host event's own keeper bit; design D-5). The eager (auto) hooks call
 *         {LibConsolidation.consolidateToHolder} directly from the host facets.
 * @dev    Kept in its own small facet so {VaultFactoryFacet} stays under the
 *         EIP-170 24,576-byte limit (cf. the #647 NumeraireConfigFacet split).
 *         Both wrappers **status-gate the loan BEFORE the `ownerOf`-based holder
 *         auth** — a terminal loan can have a burned position NFT, so resolving
 *         the holder first would revert in `ownerOf` instead of taking the
 *         documented no-op path. They pass `Tier1Strict`, so a sanctioned holder
 *         reverts; a `Skipped` result (excluded live state) surfaces as
 *         {ConsolidationNotAllowed}.
 */
contract ConsolidationFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @notice Consolidate the **borrower** (collateral) side of `loanId` into
    ///         the current borrower-NFT holder's vault.
    function consolidateCollateralToHolder(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        _standalone(loanId, /* isLenderSide */ false);
    }

    /// @notice Consolidate the **lender** (principal) side of `loanId` into the
    ///         current lender-NFT holder's vault.
    function consolidatePrincipalToHolder(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        _standalone(loanId, /* isLenderSide */ true);
    }

    /// @dev Shared holder-gated standalone path. Status-gate → holder auth →
    ///      Tier-1 primitive → map `Skipped` to a revert for explicit-caller
    ///      feedback.
    function _standalone(uint256 loanId, bool isLenderSide) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Status-gate BEFORE the ownerOf-based holder auth (terminal loans may
        // have a burned position NFT). A terminal loan is a benign success
        // no-op for an explicit consolidation of an already-closed loan.
        LibVaipakam.LoanStatus st = loan.status;
        if (
            st == LibVaipakam.LoanStatus.Repaid ||
            st == LibVaipakam.LoanStatus.Settled ||
            st == LibVaipakam.LoanStatus.Defaulted ||
            st == LibVaipakam.LoanStatus.InternalMatched
        ) {
            return;
        }

        // Holder auth lives ONLY here (k95): msg.sender must be the current
        // holder of the side's position NFT. The stored (departed) owner has no
        // claim and cannot call this.
        uint256 tokenId = isLenderSide
            ? loan.lenderTokenId
            : loan.borrowerTokenId;
        if (IERC721(address(this)).ownerOf(tokenId) != msg.sender) {
            revert NotNFTOwner();
        }

        LibConsolidation.Result r = LibConsolidation.consolidateToHolder(
            loanId,
            isLenderSide,
            LibConsolidation.Ctx.Tier1Strict
        );
        if (r == LibConsolidation.Result.Skipped) {
            revert ConsolidationNotAllowed();
        }
    }
}
