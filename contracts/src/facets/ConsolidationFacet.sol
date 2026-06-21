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
    /// @dev Raised when the internal-only eager entry is called by anything
    ///      other than the Diamond itself (a cross-facet call).
    error OnlyDiamondInternal();

    /// @notice #658 — internal-only EAGER consolidation entry for close-out
    ///         hosts. `LibConsolidation.consolidateToHolder` is an `internal`
    ///         library fn that INLINES its whole orchestrator into each caller;
    ///         size-constrained facets (RiskFacet sits ~347 bytes under EIP-170;
    ///         PrecloseFacet ~1,194) can't absorb that. They instead call this
    ///         via a few-byte `LibFacet.crossFacetCall`, so the orchestrator is
    ///         inlined ONCE here (ConsolidationFacet has ample headroom) and
    ///         every host stays under the limit.
    /// @dev    `Tier2CloseOut` (skip-not-block) — a sanctioned/excluded holder
    ///         must never block a close-out. Gated to internal callers
    ///         (`msg.sender == address(this)`); NOT `nonReentrant` (the host
    ///         already holds the Diamond's reentrancy lock when it cross-calls).
    ///         Ignores the {LibConsolidation.Result} — Skipped/NoOp/Already are
    ///         all benign for an eager hook.
    function eagerConsolidateToHolder(
        uint256 loanId,
        bool isLenderSide
    ) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibConsolidation.consolidateToHolder(
            loanId,
            isLenderSide,
            LibConsolidation.Ctx.Tier2CloseOut
        );
    }

    /// @notice #658 — internal-only EAGER consolidation of BOTH sides in one
    ///         cross-facet call. Lets a both-side close-out host (the liquidation
    ///         family) trigger borrower + lender consolidation with a single
    ///         `crossFacetCall`, halving the call-site bytecode in the
    ///         size-constrained caller (vs. two `eagerConsolidateToHolder`
    ///         calls). Same internal-only gate + `Tier2CloseOut` semantics.
    function eagerConsolidateBothSides(uint256 loanId) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibConsolidation.consolidateToHolder(
            loanId,
            /* isLenderSide */ false,
            LibConsolidation.Ctx.Tier2CloseOut
        );
        LibConsolidation.consolidateToHolder(
            loanId,
            /* isLenderSide */ true,
            LibConsolidation.Ctx.Tier2CloseOut
        );
    }

    /// @notice #658 (Codex #680 P2) — internal-only post-withdraw VPFI
    ///         re-stamp for the liquidation close-out family. The eager
    ///         consolidation above checkpoints the current borrower holder at
    ///         the FULL pre-liquidation VPFI balance (via
    ///         {LibConsolidation.consolidateToHolder} → `_restampVpfi`); the
    ///         host then withdraws some/all of that VPFI collateral out of the
    ///         holder's vault for the swap. Without a post-withdraw re-stamp the
    ///         holder keeps fee-tier / staking credit on VPFI that already left
    ///         until their next VPFI action — the same gaming vector the
    ///         eager-withdraw hosts (AddCollateral / SwapToRepay /
    ///         PartialWithdrawal) close. Size-constrained liquidation hosts
    ///         (RiskFacet ~298 bytes under EIP-170) can't inline
    ///         `restampUserVpfi` (it pulls in the discount + staking rollups),
    ///         so they cross-call this after the withdrawal. No-op for non-VPFI
    ///         collateral. Internal-only; NOT `nonReentrant` (the host holds the
    ///         lock).
    function restampCollateralVpfiAfterWithdraw(uint256 loanId) external {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.collateralAsset == s.vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }
    }

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
