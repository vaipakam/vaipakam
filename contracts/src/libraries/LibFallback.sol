// src/libraries/LibFallback.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
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
    ///
    ///      Phase 2 of AutonomousLtvAndOracleFallback.md design — switched
    ///      from `getAssetPrice` (which reverts on stale / missing feeds)
    ///      to `tryGetAssetPrice` (returns `ok=false` on failure) so the
    ///      caller can detect oracle-quorum unavailability and route to
    ///      the full-collateral fallback instead of having the whole
    ///      liquidation revert. Sentinel return when oracle fails is `0`
    ///      — the surrounding {computeFallbackEntitlements} surfaces
    ///      this via its `oracleAvailable` flag, and {RiskFacet}'s
    ///      `_fullCollateralTransferFallback` switches branches
    ///      accordingly.
    function collateralEquivalent(
        address diamond,
        uint256 principalAmount,
        address collateralAsset,
        address principalAsset
    ) internal view returns (uint256) {
        (bool colOk, uint256 colPrice, uint8 colFeedDec) = OracleFacet(diamond)
            .tryGetAssetPrice(collateralAsset);
        (bool prinOk, uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(diamond)
            .tryGetAssetPrice(principalAsset);
        if (!colOk || !prinOk) return 0;
        if (colPrice == 0 || prinPrice == 0) return 0;
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        return
            (principalAmount * prinPrice * (10 ** colTokenDec) *
                (10 ** colFeedDec)) /
            (colPrice * (10 ** prinTokenDec) * (10 ** prinFeedDec));
    }

    /// @notice The principal-asset VALUE of `collateralAmount` at the current
    ///         oracle (the inverse of {collateralEquivalent}).
    /// @dev Returns 0 if either leg's oracle is unavailable (mirrors
    ///      {collateralEquivalent}), so callers can treat 0 as "can't value ⇒
    ///      refuse". Used by the #399 backstop Role-B par-guard to check the
    ///      lender slice's value directly (`value >= lenderPrincipalDue`) rather
    ///      than round the required collateral down — the latter would let a
    ///      low-decimal slice be accepted up to one base unit of value below par.
    function principalEquivalent(
        address diamond,
        uint256 collateralAmount,
        address collateralAsset,
        address principalAsset
    ) internal view returns (uint256) {
        (bool colOk, uint256 colPrice, uint8 colFeedDec) = OracleFacet(diamond)
            .tryGetAssetPrice(collateralAsset);
        (bool prinOk, uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(diamond)
            .tryGetAssetPrice(principalAsset);
        if (!colOk || !prinOk) return 0;
        if (colPrice == 0 || prinPrice == 0) return 0;
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        return
            (collateralAmount * colPrice * (10 ** prinTokenDec) *
                (10 ** prinFeedDec)) /
            (prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec));
    }

    /// @dev README §7 three-way split: lender gets collateral equivalent of
    ///      (principal + accrued interest + 3% of principal); treasury gets
    ///      2% of principal equivalent; borrower gets the remainder. Late
    ///      fees are intentionally excluded from the retry-failed branch per
    ///      README §7 (lines 168, 333, 373) — the 3% + 2% premium is the
    ///      codified compensation for the fallback path. When collateral is
    ///      insufficient to cover the lender entitlement, the lender receives
    ///      the full remaining collateral and the other two are zeroed out.
    ///
    ///      Phase 2 of AutonomousLtvAndOracleFallback.md — added the
    ///      `oracleAvailable` return so callers can distinguish the
    ///      oracle-priced fair-value-equivalent split (this function's
    ///      classic behaviour, now reachable only when both legs have a
    ///      fresh oracle-quorum reading via `tryGetAssetPrice`) from the
    ///      full-collateral-to-lender fallback (when oracle quorum is
    ///      stale or missing). On oracle failure, `collateralEquivalent`
    ///      returns 0 → `lenderCol` is 0 → the existing
    ///      `collateralAmount <= lenderCol` branch lands lender = full
    ///      collateral, others = 0, *but* the caller no longer has a way
    ///      to distinguish "oracle worked and lender's entitlement
    ///      exceeded collateral" from "oracle failed". The
    ///      `oracleAvailable` flag disambiguates: callers emit a
    ///      different event and the audit-package can trace which path
    ///      ran on each fallback.
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
            uint256 treasuryPrincipalDue,
            bool oracleAvailable
        )
    {
        // #641 — accrue from the interest clock (post-partial origin), not the
        // immutable term start, so a previously partial-liquidated loan's
        // fallback split is computed on its true post-partial accrual.
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        uint256 accrued = (loan.principal * loan.interestRateBps * elapsed) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        // #915 (M7 / spec-review S12) — credit interest already forwarded to the
        // lender via periodic auto-liquidation (`loan.interestSettled`) so the
        // in-kind fallback split does not over-allocate collateral to the lender
        // for interest that was already paid. The accrual clock is not reset by
        // periodic settlement, so the raw `accrued` still spans those periods.
        accrued = LibEntitlement.creditSettledInterest(loan, accrued);
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

        // Oracle-availability gate: `collateralEquivalent` returns 0 ONLY
        // when at least one leg's oracle is unavailable (verified via
        // `tryGetAssetPrice`). A zero lenderPrincipalDue should never
        // happen (principal > 0 always for a fallback-eligible loan),
        // so a zero `lenderCol` is a reliable oracle-failure signal.
        // When oracle fails, drive the full-collateral-to-lender branch
        // and signal it via the `oracleAvailable` flag.
        oracleAvailable = lenderCol > 0;
        if (!oracleAvailable) {
            // Full collateral to lender; treasury + borrower zeroed.
            // Same numbers as the existing "collateral insufficient"
            // branch below, but reached because we can't price anything,
            // not because the lender's claim is large.
            lenderCollateral = loan.collateralAmount;
            treasuryCollateral = 0;
            borrowerCollateral = 0;
            return (
                lenderCollateral,
                treasuryCollateral,
                borrowerCollateral,
                lenderPrincipalDue,
                treasuryPrincipalDue,
                false
            );
        }

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
