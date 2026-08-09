// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {RiskFacet} from "../facets/RiskFacet.sol";

/**
 * @title  LibSaleSolvency
 * @notice #1503 PR-E (design item 11) — the solvency admission floor a
 *         live loan must clear before a NEW lender may be admitted into
 *         it by sale.
 *
 * @dev    Opening an ordinary loan requires a Health Factor at or above
 *         the protocol admission floor, and a position that falls under
 *         the liquidation threshold is permissionlessly liquidatable.
 *         Before this library, neither lender-exit sale path checked
 *         either bound: both gated on the loan being `Active` and
 *         nothing more. A lender watching collateral fall could hand an
 *         already-underwater — possibly same-block liquidatable —
 *         position to a counterparty whose terms were authored on the
 *         assumption that a new position starts comfortably
 *         over-collateralized, at a price computed from principal and
 *         accrued interest, which says nothing about a collateral
 *         shortfall.
 *
 *         A sale is an ADMISSION, not a transfer of an already-accepted
 *         risk: the incoming lender never underwrote this loan. So the
 *         floor is the same one the loan itself was admitted under —
 *         `minHealthFactorAtInit`, read through
 *         `LibVaipakam.effectiveLoanMinHealthFactor` — rather than the
 *         bare liquidation trigger. Using the loan's own SNAPSHOT (not
 *         the live `minHealthFactor()`) keeps a governance retune from
 *         retroactively freezing open positions out of the sale paths,
 *         the same rule every other post-admission HF check in the
 *         protocol follows.
 *
 *         Factored into a library because three call sites in two
 *         facets need it and both facets are close to the EIP-170
 *         ceiling.
 */
library LibSaleSolvency {
    /// @notice The position's live Health Factor is below the floor its
    ///         own admission required, so it may not be sold into a new
    ///         lender's hands. Carries both figures so the frontend can
    ///         render "HF 1.21 — sale requires 1.50" without a second
    ///         read.
    error SalePositionBelowSolvencyFloor(
        uint256 loanId,
        uint256 healthFactor,
        uint256 floor
    );

    /**
     * @notice Reverts unless `loanId` is solvent enough to admit a new
     *         lender by sale.
     *
     * @dev    ILLIQUID POSITIONS ARE OUT OF SCOPE, not silently
     *         admitted. Health Factor is a ratio of oracle-priced
     *         values; `RiskFacet.calculateHealthFactor` reverts
     *         `IlliquidLoanNoRiskMath` when either leg lacks a price,
     *         and the protocol values illiquid collateral at $0 — so
     *         computing a floor for those would refuse every illiquid
     *         sale rather than measure anything. Illiquid positions are
     *         governed by the explicit both-parties-consent regime
     *         instead; this floor is the guard for the priced case.
     *
     *         The HF read is a plain cross-facet call, NOT the
     *         `staticcall`-and-degrade-to-zero pattern used for
     *         best-effort EVENT payloads (`PrecloseFacet`,
     *         `AddCollateralFacet`). This is a GUARD: if the oracle
     *         cannot price a position we claim is priceable, the sale
     *         must fail closed rather than admit a buyer against an
     *         unverifiable figure.
     */
    function assertSaleSolvent(uint256 loanId) internal view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) return;

        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        uint256 floor = LibVaipakam.effectiveLoanMinHealthFactor(
            loan.minHealthFactorAtInit
        );
        if (hf < floor) {
            revert SalePositionBelowSolvencyFloor(loanId, hf, floor);
        }
    }

    /**
     * @notice Non-reverting form for preview / classification surfaces.
     * @return solvent True when a sale would clear the floor (including
     *         the out-of-scope illiquid case, which this guard does not
     *         block).
     * @return hf      The live Health Factor, or 0 where undefined.
     * @return floor   The floor that applies, or 0 where undefined.
     */
    function saleSolvency(uint256 loanId)
        internal
        view
        returns (bool solvent, uint256 hf, uint256 floor)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) return (true, 0, 0);

        // Preview must never revert the caller's whole read, so an
        // unpriceable position degrades here — reported as NOT solvent,
        // which matches what `assertSaleSolvent` would do to the
        // transaction (fail closed).
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                loanId
            )
        );
        if (!ok || ret.length < 32) return (false, 0, 0);

        hf = abi.decode(ret, (uint256));
        floor = LibVaipakam.effectiveLoanMinHealthFactor(
            loan.minHealthFactorAtInit
        );
        solvent = hf >= floor;
    }
}
