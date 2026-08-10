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
 *         the incoming lender never underwrote this loan. Three things follow,
 *         and only the first is obvious:
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
 *           3. Liquidity is judged TODAY, on the live classifier rather than
 *              the loan's origination snapshot. Every figure the first two
 *              rules compare is oracle-derived, so a position the protocol can
 *              no longer price cannot be measured at all — and a snapshot that
 *              still says `Liquid` for a market that has degraded would have
 *              those rules compare prices the protocol no longer accepts
 *              (#1655).
 *
 *         The design permits binding those snapshots into the buyer's consent
 *         OR requiring compatibility with current parameters; this takes the
 *         latter, which needs no new consent surface.
 *
 *         For the unpriceable case the design reserves the policy for the
 *         contract owners; this takes the Phase-1 EXCLUSION, and takes it
 *         unconditionally. The progressive-risk-access consent ladder is not a
 *         substitute: it classifies assets by identity and depth class, so a
 *         blue-chip leg with a stale feed is unpriceable while still requiring
 *         no opt-up or pair consent, and deferring to it would wave exactly
 *         that position through (Codex #1635 r8). Refusing here is not the
 *         "silent blocking" the design doc rules out — the refusal names the
 *         condition and the leg. See the note on `saleAdmission`.
 *
 *         The logic itself lives on `RiskPreviewFacet.saleAdmission` — it owns the
 *         health factor and every parameter consulted, and both calling
 *         facets were already at the EIP-170 ceiling. This library is only
 *         the mapping from that classification onto the errors, which stay
 *         declared here so they surface in the calling facets' ABIs.
 */
library LibSaleSolvency {
    /// @notice Sentinel returned by `saleSolvency` when the classifier itself
    ///         could not be consulted — an unpriceable position, or the
    ///         selector not being routed at all. NOT a measured refusal: it
    ///         says "not admissible, and the reason was not measurable", which
    ///         is a different statement from any of the classifier's codes.
    ///         Deliberately `type(uint8).max` rather than the next free number,
    ///         so extending the classifier's range — 0-5 when this was written,
    ///         0-6 since #1655 added the unpriceable-leg refusal — can never
    ///         collide with it (Codex #1635 r5).
    uint8 internal constant SALE_ADMISSION_UNAVAILABLE = type(uint8).max;

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

    /// @notice One of the position's legs is not priceable by protocol policy
    ///         RIGHT NOW, so there is no figure to admit an incoming lender
    ///         against. Raised regardless of the progressive-risk-access
    ///         switch — that ladder gates on what an asset IS, not on whether
    ///         it can currently be priced, so it cannot consent to this.
    ///         `which`: 0 collateral, 1 principal. Carries no figures on
    ///         purpose: the refusal is for want of a measurement, and quoting a
    ///         health factor for a position that has none is the dishonest
    ///         surface `LenderEarlyWithdrawalUXDesign.md` 717-736 rules out.
    ///         Judged on the live `OracleFacet.checkLiquidity` reading rather
    ///         than the loan's origination snapshot — see the note on
    ///         `saleAdmission` (#1655).
    error SaleLegUnpriceable(uint256 loanId, uint8 which);

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
        // 6 carries the unpriceable leg in `a` (0 collateral, 1 principal)
        // rather than a pair of figures — there is no measurement to report,
        // which is the whole point of the refusal.
        if (code == 6) revert SaleLegUnpriceable(loanId, uint8(a));
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
     * @return code  The classifier's code, verbatim — 0 admissible — or
     *         `SALE_ADMISSION_UNAVAILABLE` when the classifier could not be
     *         consulted at all. Returned rather than collapsed to a bool so a
     *         preview can name the ACTUAL reason: reporting "health factor
     *         below floor" for what is really a weaker-inherited-terms refusal,
     *         an over-cap refusal, or a failed price read would tell the buyer
     *         something false about their own position.
     * @return a The position's figure for the failing check, else 0.
     * @return b The figure it must meet, else 0.
     */
    function saleSolvency(uint256 loanId)
        internal
        view
        returns (uint8 code, uint256 a, uint256 b)
    {
        // Preview must never revert the caller's whole read, so a classifier
        // that reverts degrades here rather than taking the surrounding read
        // down with it.
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(RiskPreviewFacet.saleAdmission.selector, loanId)
        );
        // Codex #1635 r5 — this used to degrade to code 1, which the preview
        // renders as `SalePositionBelowSolvencyFloor`. That was wrong twice
        // over: it asserted a MEASURED health-factor shortfall (with 0/0 as the
        // figures) when nothing had been measured, and it diverged from the
        // guard, which does NOT map an oracle failure onto the floor error —
        // `assertSaleSolvent` bubbles the classifier's own revert. Both agree
        // the sale is refused; only the stated reason differed, and the preview
        // told the buyer something false about their position. The sentinel
        // keeps "refused" and drops the invented cause: the caller maps it onto
        // its neutral blocked result.
        if (!ok || ret.length < 96) return (SALE_ADMISSION_UNAVAILABLE, 0, 0);
        return abi.decode(ret, (uint8, uint256, uint256));
    }
}
