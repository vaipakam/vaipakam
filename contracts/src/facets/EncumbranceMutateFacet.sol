// src/facets/EncumbranceMutateFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title  EncumbranceMutateFacet
 * @notice #407 PR 2 (2026-06-12) — thin cross-facet entry for the
 *         encumbrance sub-ledger's mutate surface. Created to keep
 *         each loan-lifecycle terminal's bytecode minimal: a direct
 *         `LibEncumbrance.releaseCollateralLien(...)` inlines ~150
 *         bytes into the caller; a `crossFacetCall` to this facet
 *         adds only ~50 bytes per call site.
 *
 *         This unlocks release wiring at the remaining loan-lifecycle
 *         terminals that were blocked by the EIP-170 24,576-byte
 *         ceiling in PR 1 (notably `RepayFacet.repayLoan`,
 *         `PrecloseFacet.precloseDirect`, `RefinanceFacet`'s
 *         old-loan close, and `ClaimFacet`'s Settled transitions).
 *
 * @dev    All selectors gated to `msg.sender == address(this)` so an
 *         external EOA cannot reach the lien mutate surface
 *         directly — only the diamond itself (via `crossFacetCall`)
 *         can mutate.
 *
 *         See `docs/DesignsAndPlans/PerLoanCollateralLien.md` §3.4.
 */
contract EncumbranceMutateFacet {
    /// @notice Mirror of the `onlyDiamondInternal` pattern in
    ///         `VaultFactoryFacet` + `RefinanceFacet.refinanceLoanFromAccept`.
    error OnlyDiamondInternal();

    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }

    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    /// @notice Release a per-loan collateral lien in full. Idempotent
    ///         (already-released or empty rows are no-ops). Callers
    ///         (loan-lifecycle terminal facets) invoke this via
    ///         `LibFacet.crossFacetCall` so the heavy lifting (the
    ///         aggregate decrement + tombstone) lives in this facet's
    ///         bytecode, not the caller's.
    function releaseCollateralLien(uint256 loanId)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.releaseCollateralLien(loanId);
    }

    /// @notice #407 PR 4 round-1 Codex P1 #1 (2026-06-12) — decrement
    ///         an active lien by `consumed`. See
    ///         {LibEncumbrance.decrementCollateralLien}.
    function decrementCollateralLien(uint256 loanId, uint256 consumed)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.decrementCollateralLien(loanId, consumed);
    }

    /// @notice #407 PR 4 round-1 Codex P2 #6 (2026-06-12) — increment
    ///         an active lien by `added`. See
    ///         {LibEncumbrance.incrementCollateralLien}.
    function incrementCollateralLien(uint256 loanId, uint256 added)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.incrementCollateralLien(loanId, added);
    }

    /// @notice #569 §4.4 (2026-06-13) — re-create the lien from the
    ///         loan row's CURRENT `(borrower, collateralAsset, amount)`
    ///         state. Used as the create-leg of an obligation-transfer
    ///         rekey (`PrecloseFacet.transferObligationViaOffer`):
    ///         after the old borrower's lien is released and the loan
    ///         is rewritten to the new borrower, this locks the new
    ///         borrower's collateral. No-op on NFT-rental loans (D-1).
    ///         See {LibEncumbrance.recreateCollateralLien}.
    function recreateCollateralLien(uint256 loanId)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.recreateCollateralLien(
            loanId,
            LibVaipakam.storageSlot().loans[loanId]
        );
    }
}
