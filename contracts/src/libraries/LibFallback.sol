// src/libraries/LibFallback.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibFallback
 * @notice Pure oracle-based math shared by DefaultedFacet and RiskFacet for
 *         the time-based default and HF-based liquidation fallback paths.
 *         Previously duplicated verbatim across both facets — consolidated
 *         here to shrink audit surface. Oracle lookups require the diamond
 *         address since these run inside facets that share storage via
 *         LibVaipakam.storageSlot() but must invoke OracleFacet through the
 *         diamond's fallback to hit the correct facet.
 */
library LibFallback {
    /// @dev Oracle-derived expected swap output in principal-asset token
    ///      units. Assumes both assets are liquid (caller must verify).
    ///      getAssetPrice reverts on missing/stale feeds.
    function expectedSwapOutput(
        address diamond,
        address collateralAsset,
        address principalAsset,
        uint256 collateralAmount
    ) internal view returns (uint256) {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(diamond)
            .getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(diamond)
            .getAssetPrice(principalAsset);
        if (prinPrice == 0) return 0;

        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();

        // expected = collateralAmount * colPrice / 10^colFeedDec / 10^colTokenDec
        //          * 10^prinTokenDec * 10^prinFeedDec / prinPrice
        // Rearranged to preserve precision:
        return
            (collateralAmount * colPrice * (10 ** prinTokenDec) *
                (10 ** prinFeedDec)) /
            (prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec));
    }

    /// @dev Inverse of `expectedSwapOutput` — converts a principal-asset
    ///      amount into collateral-asset units. Both sides must be liquid.
    function collateralEquivalent(
        address diamond,
        uint256 principalAmount,
        address collateralAsset,
        address principalAsset
    ) internal view returns (uint256) {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(diamond)
            .getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(diamond)
            .getAssetPrice(principalAsset);
        if (colPrice == 0) return 0;
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        return
            (principalAmount * prinPrice * (10 ** colTokenDec) *
                (10 ** colFeedDec)) /
            (colPrice * (10 ** prinTokenDec) * (10 ** prinFeedDec));
    }

    /// @dev README §7 three-way split: lender gets collateral equivalent of
    ///      (principal + accrued interest + 3% of principal); treasury gets
    ///      2% of principal equivalent; borrower gets the remainder. Late
    ///      fees are intentionally excluded from the retry-failed branch per
    ///      README §7 (lines 168, 333, 373) — the 3% + 2% premium is the
    ///      codified compensation for the fallback path. When collateral is
    ///      insufficient to cover the lender entitlement, the lender receives
    ///      the full remaining collateral and the other two are zeroed out.
    function computeFallbackEntitlements(
        address diamond,
        LibVaipakam.Loan storage loan,
        uint256 /* loanId */
    )
        internal
        view
        returns (
            uint256 lenderCollateral,
            uint256 treasuryCollateral,
            uint256 borrowerCollateral,
            uint256 lenderPrincipalDue,
            uint256 treasuryPrincipalDue
        )
    {
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 accrued = (loan.principal * loan.interestRateBps * elapsed) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        // Prospective fallback split: read from the values snapshotted at
        // `initiateLoan` so any subsequent governance change via
        // `ConfigFacet.setFallbackSplit` does NOT retroactively alter the
        // dual-consent contract. A zero snapshot (pre-upgrade loan) falls
        // through to the compile-time defaults so legacy loans settle at
        // the original 3% / 2% terms they were created under.
        uint256 lenderBonusBps = loan.fallbackLenderBonusBpsAtInit == 0
            ? LibVaipakam.FALLBACK_LENDER_BONUS_BPS
            : uint256(loan.fallbackLenderBonusBpsAtInit);
        uint256 treasuryBps = loan.fallbackTreasuryBpsAtInit == 0
            ? LibVaipakam.FALLBACK_TREASURY_BPS
            : uint256(loan.fallbackTreasuryBpsAtInit);
        uint256 principalBonus = (loan.principal * lenderBonusBps) /
            LibVaipakam.BASIS_POINTS;
        lenderPrincipalDue = loan.principal + accrued + principalBonus;
        treasuryPrincipalDue = (loan.principal * treasuryBps) / LibVaipakam.BASIS_POINTS;

        uint256 lenderCol = collateralEquivalent(
            diamond,
            lenderPrincipalDue,
            loan.collateralAsset,
            loan.principalAsset
        );
        uint256 treasuryCol = collateralEquivalent(
            diamond,
            treasuryPrincipalDue,
            loan.collateralAsset,
            loan.principalAsset
        );

        if (loan.collateralAmount <= lenderCol) {
            lenderCollateral = loan.collateralAmount;
            treasuryCollateral = 0;
            borrowerCollateral = 0;
        } else {
            lenderCollateral = lenderCol;
            uint256 rem = loan.collateralAmount - lenderCol;
            treasuryCollateral = treasuryCol <= rem ? treasuryCol : rem;
            borrowerCollateral = rem - treasuryCollateral;
        }
    }
}
