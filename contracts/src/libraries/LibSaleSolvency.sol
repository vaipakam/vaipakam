// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RiskPreviewFacet} from "../facets/RiskPreviewFacet.sol";

/**
 * @title  LibSaleSolvency
 * @notice #1503 PR-E (design item 11) — the admission test a live loan must
 *         clear before a NEW lender may be admitted into it by sale.
 *
 * @dev    Both lender-exit sale paths used to gate on the loan being `Active`
 *         and nothing more. A lender watching collateral fall could hand an
 *         already-underwater — possibly same-block liquidatable — position to
 *         a counterparty whose standing offer was authored for a fresh,
 *         comfortably over-collateralized one, priced from principal and
 *         accrued interest, figures that say nothing about a shortfall.
 *
 *         A sale is an ADMISSION, not a hand-off of already-accepted risk:
 *         the incoming lender never underwrote this loan. Two things follow,
 *         and the second is easy to miss:
 *
 *           1. The position must clear the health floor its own origination
 *              required.
 *           2. Its INHERITED risk snapshots must be no weaker than a loan
 *              originated today would carry. Migrating the position changes
 *              the lender, not `minHealthFactorAtInit` /
 *              `liquidationLtvBpsAtInit` / `initLtvCapBpsAtInit`, so if
 *              governance has tightened since, the buyer silently inherits a
 *              looser collateral-withdrawal floor and a later liquidation
 *              point than they could be sold today. A fill-time health read
 *              cannot see this — the position is perfectly solvent against
 *              its own old terms.
 *
 *         The design permits binding those snapshots into the buyer's consent
 *         OR requiring compatibility with current parameters; this takes the
 *         latter, which needs no new consent surface.
 *
 *         The logic itself lives on `RiskPreviewFacet.saleAdmission` — it owns the
 *         health factor and every parameter consulted, and both calling
 *         facets were already at the EIP-170 ceiling. This library is only
 *         the mapping from that classification onto the errors, which stay
 *         declared here so they surface in the calling facets' ABIs.
 */
library LibSaleSolvency {
    /// @notice The position's live Health Factor is below the floor its own
    ///         admission required. Carries both figures so a frontend can
    ///         render "HF 1.21 — sale requires 1.50" without a second read.
    error SalePositionBelowSolvencyFloor(
        uint256 loanId,
        uint256 healthFactor,
        uint256 floor
    );

    /// @notice The position's INHERITED risk snapshots are weaker than what a
    ///         loan originated today would carry, so the incoming lender would
    ///         take on collateral bounds they could not be given on a fresh
    ///         loan. `which`: 0 admission health floor, 1 liquidation LTV,
    ///         2 init-LTV cap.
    error SaleInheritsWeakerRiskTerms(
        uint256 loanId,
        uint8 which,
        uint256 inherited,
        uint256 current
    );

    /// @notice The position's LIVE loan-to-value exceeds the cap a fresh
    ///         admission would allow, so it could not be originated today at
    ///         this collateralisation even though its health factor clears the
    ///         floor.
    error SaleLtvAboveAdmissionCap(
        uint256 loanId,
        uint256 liveLtvBps,
        uint256 capBps
    );

    /**
     * @notice Reverts unless `loanId` may admit a new lender by sale.
     *
     * @dev    A plain cross-facet call, NOT the `staticcall`-and-degrade
     *         pattern used for best-effort event payloads. This is a GUARD:
     *         if the oracle cannot price a position we believe is priceable,
     *         `saleAdmission` reverts and so does the sale, rather than
     *         admitting a buyer against an unverifiable figure.
     */
    function assertSaleSolvent(uint256 loanId) internal view {
        (uint8 code, uint256 a, uint256 b) =
            RiskPreviewFacet(address(this)).saleAdmission(loanId);
        if (code == 0) return;
        if (code == 1) revert SalePositionBelowSolvencyFloor(loanId, a, b);
        if (code == 5) revert SaleLtvAboveAdmissionCap(loanId, a, b);
        // 2/3/4 map onto which = 0/1/2.
        revert SaleInheritsWeakerRiskTerms(loanId, code - 2, a, b);
    }

    /**
     * @notice Non-reverting form for preview / classification surfaces.
     * @dev    Reads the SAME classifier the guard does, so a preview cannot
     *         drift from what acceptance will actually do — a preview that
     *         re-derived the rules would eventually quote a sale as fine and
     *         let the accept revert, which is the failure this change exists
     *         to remove, reintroduced one layer down.
     * @return code  The classifier's code, verbatim — 0 admissible. Returned
     *         rather than collapsed to a bool so a preview can name the ACTUAL
     *         reason: reporting "health factor below floor" for what is really
     *         a weaker-inherited-terms or over-cap refusal would tell the buyer
     *         something false about their own position.
     * @return a The position's figure for the failing check, else 0.
     * @return b The figure it must meet, else 0.
     */
    function saleSolvency(uint256 loanId)
        internal
        view
        returns (uint8 code, uint256 a, uint256 b)
    {
        // Preview must never revert the caller's whole read, so an unpriceable
        // position degrades here — reported as NOT admissible, matching what
        // the guard would do to the transaction (fail closed).
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(RiskPreviewFacet.saleAdmission.selector, loanId)
        );
        // An unpriceable position that claims to be priceable degrades to code
        // 1 (below floor) — fail closed, matching what the guard does to the
        // transaction.
        if (!ok || ret.length < 96) return (1, 0, 0);
        return abi.decode(ret, (uint8, uint256, uint256));
    }
}
