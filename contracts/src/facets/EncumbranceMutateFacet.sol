// src/facets/EncumbranceMutateFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";

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

    /// @notice #954 (§1.1) — freeze a full swap-to-repay's LENDER proceeds into
    ///         the stored lender's vault behind the receive-side sanctions
    ///         exemption, write the lender claim row, encumber the proceeds for
    ///         every ERC20, and tier-exclude a transferred-and-sanctioned
    ///         holder's VPFI. See {LibCloseoutFreeze.freezeLenderProceeds}.
    /// @dev    Hosted here (not inlined in `SwapToRepayFacet`) so that facet
    ///         stays under the EIP-170 ceiling after the #959 merge — a
    ///         crossFacetCall stub is ~50 bytes vs the inlined helper. Runs in
    ///         the diamond's storage context, so `LibCloseoutFreeze` reads the
    ///         live loan and the diamond-held proceeds exactly as an inline call
    ///         would. The Fusion intent path inlines the SAME helper directly
    ///         (it has bytecode room), so both close-out terminals share one
    ///         logic source and cannot drift.
    function freezeLenderProceeds(uint256 loanId, uint256 lenderDue)
        external
        onlyDiamondInternal
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibCloseoutFreeze.freezeLenderProceeds(s, loanId, s.loans[loanId], lenderDue);
    }

    /// @notice #954 (§2.1) — pay or FREEZE a full swap-to-repay's borrower
    ///         principal SURPLUS: direct EOA payout for a clean current holder,
    ///         freeze-at-source into the stored borrower's vault (+ surplus claim
    ///         row + encumber-all + VPFI tier-exclude) for a sanctioned one. See
    ///         {LibCloseoutFreeze.freezeOrPayBorrowerSurplus}. Hosted here for
    ///         the same EIP-170 reason as {freezeLenderProceeds}.
    function freezeOrPayBorrowerSurplus(
        uint256 loanId,
        address currentHolder,
        uint256 surplus
    ) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibCloseoutFreeze.freezeOrPayBorrowerSurplus(
            s, loanId, s.loans[loanId], currentHolder, surplus
        );
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

    /// @notice #998 S10 (#1006) — record the fail-closed frozen-claimant marker
    ///         for a `(loanId, side)` close-out park, keyed to the CURRENT
    ///         position-NFT holder (the intended economic claimant). See
    ///         {LibSanctionedLock.recordFrozenClaimantForLoan}.
    /// @dev    Hosted here (not inlined) for the EIP-170-tight liquidation /
    ///         close-out facets (`RiskFacet`, `DefaultedFacet`, `PrecloseFacet`),
    ///         which cross-call it exactly as they cross-call
    ///         {incrementCollateralLien}. Facets with bytecode room inline the
    ///         helper directly (same inline-where-possible policy as
    ///         {freezeLenderProceeds}). Runs in the diamond's storage context, so
    ///         the marker lands in shared storage regardless of caller.
    function recordSanctionsFrozenClaimant(uint256 loanId, bool lenderSide)
        external
        onlyDiamondInternal
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibSanctionedLock.recordFrozenClaimantForLoan(s, s.loans[loanId], lenderSide);
    }

    // ─── Offer-principal lock (T-407-C, #566) — second lien category ────
    //
    // The per-offer principal lock for ERC20 Lender offers. The creator's
    // offered principal sits in their own vault from offer-create; these
    // selectors keep the encumbrance aggregate aware of it so the creator
    // cannot withdraw the locked portion before cancelling/filling the
    // offer (the same `encumbered[user][asset][0]` aggregate the withdraw
    // chokepoint guard reads). All gated `onlyDiamondInternal`; the lib
    // functions live here (not inlined at the offer-flow call sites) to
    // keep those bytecode-sensitive facets under the EIP-170 ceiling.

    /// @notice Create the offer-principal lock at offer-create
    ///         (`OfferCreateFacet._pullCreatorAssetsClassic`, Lender+ERC20
    ///         branch). See {LibEncumbrance.createOfferPrincipalLien}.
    function createOfferPrincipalLien(
        uint256 offerId,
        address creator,
        address lendingAsset,
        uint256 amount
    ) external onlyDiamondInternal {
        LibEncumbrance.createOfferPrincipalLien(offerId, creator, lendingAsset, amount);
    }

    /// @notice Decrement the offer-principal lock by `consumed` on each
    ///         partial-fill match (`OfferMatchFacet.matchOffers`). See
    ///         {LibEncumbrance.decrementOfferPrincipalLien}.
    function decrementOfferPrincipalLien(uint256 offerId, uint256 consumed)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.decrementOfferPrincipalLien(offerId, consumed);
    }

    /// @notice Grow the offer-principal lock by `added` when a lender
    ///         raises an unaccepted offer's `amountMax`
    ///         (`OfferMutateFacet.setOfferAmount` / `modifyOffer`). See
    ///         {LibEncumbrance.incrementOfferPrincipalLien}.
    function incrementOfferPrincipalLien(uint256 offerId, uint256 added)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.incrementOfferPrincipalLien(offerId, added);
    }

    /// @notice Release the offer-principal lock in full on cancel /
    ///         single-fill accept / dust-close / lazy-expiry. Idempotent.
    ///         See {LibEncumbrance.releaseOfferPrincipalLien}.
    function releaseOfferPrincipalLien(uint256 offerId)
        external
        onlyDiamondInternal
    {
        LibEncumbrance.releaseOfferPrincipalLien(offerId);
    }
}
