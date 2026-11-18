// src/libraries/LibNewLoanRisk.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RiskFacet} from "../facets/RiskFacet.sol";
import {CollateralConcentrationFacet} from "../facets/CollateralConcentrationFacet.sol";

/**
 * @title  LibNewLoanRisk
 * @author Vaipakam Developer Team
 * @notice The ONE risk check a loan must pass to be taken on as new: its
 *         loan-to-value within the cap a new loan on its collateral gets
 *         today, and its health factor at or above today's admission floor.
 * @dev    Read live, never from the loan's snapshots: the question is whether
 *         a new loan in this position would be admitted now. Run by the
 *         binding accept ({LoanFacet}) on every both-liquid pair
 *         ({LibInitRiskGate.applies}), and by the instant-market takeover
 *         ({InstantTakeoverFacet}), which hands an open loan to a lender who
 *         takes it on as new (InstantMarketDesign §7). Two copies of this rule
 *         drifted once (the takeover held every loan to the 1.5 default), so
 *         it lives here only.
 */
library LibNewLoanRisk {
    /// @notice Revert unless loan `loanId`, as it stands now, passes the
    ///         new-loan cap and floor.
    /// @dev    Depth-tiered regime: LTV within the tier cap for the
    ///         collateral's effective tier (`InitLtvAboveTier`) and HF at or
    ///         above the liquidation trigger. Untiered: LTV within the
    ///         per-asset ceiling (`LTVExceeded`) and HF at or above the
    ///         tunable admission floor. Either regime is held to the lowered
    ///         cap while the collateral is at the High concentration level
    ///         (#3685). The floor is {LibVaipakam.admissionHealthFactorFloor}.
    function requireAdmissible(uint256 loanId, address collateralAsset) internal view {
        (bool ltvOk, bytes memory ltvRet) =
            address(this).staticcall(abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId));
        if (!ltvOk) revert IVaipakamErrors.LTVCalculationFailed();
        uint256 ltv = abi.decode(ltvRet, (uint256));
        (uint256 cap,,,) =
            CollateralConcentrationFacet(address(this)).newLoanInitLtvCapBps(collateralAsset);
        if (ltv > cap) {
            if (LibVaipakam.cfgDepthTieredLtvEnabled()) revert IVaipakamErrors.InitLtvAboveTier(ltv, cap);
            revert IVaipakamErrors.LTVExceeded();
        }
        uint256 hf = abi.decode(
            LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                IVaipakamErrors.HealthFactorCalculationFailed.selector
            ),
            (uint256)
        );
        if (hf < LibVaipakam.admissionHealthFactorFloor()) revert IVaipakamErrors.HealthFactorTooLow();
    }
}
