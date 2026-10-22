// src/libraries/LibFallback.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
    /// @notice The oracle exchange rate between a loan's collateral and
    ///         principal assets, held as an exact fraction so each caller
    ///         chooses its own rounding: collateral units = principal units
    ///         × `num` / `den`, and principal units = collateral units ×
    ///         `den` / `num`. Both legs' token and feed decimals are folded
    ///         in, so the fraction converts raw token units directly.
    struct Rate {
        uint256 num;
        uint256 den;
    }

    /// @dev The rate at the current oracle, read through the ordinary price
    ///      reader: a missing, stale or divergent feed on either leg reverts
    ///      with that reader's own error. For paths that cannot proceed
    ///      without a price (a swap's expected output, the sizing of a sale).
    function oracleRate(
        address diamond,
        address collateralAsset,
        address principalAsset
    ) internal view returns (Rate memory) {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(diamond)
            .getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(diamond)
            .getAssetPrice(principalAsset);
        return _rate(collateralAsset, principalAsset, colPrice, colFeedDec, prinPrice, prinFeedDec);
    }

    /// @dev The rate at the current oracle, telling a MISSING price from a
    ///      DISTRUSTED one (`OracleFacet.getAssetPriceStatus`, #666):
    ///      - `priced` is false when either leg has no price at all, or
    ///        reads zero. The pair cannot be priced whatever the other leg
    ///        says, so a caller may take its unpriced branch.
    ///      - Otherwise, when either leg's price is distrusted (the sources
    ///        that read checks against disagree: the secondary quorum, or
    ///        the Pyth cross-check of the ETH reference), this REVERTS with
    ///        that read's own error (`OraclePriceDivergence` or
    ///        `OracleCrossCheckDivergence`), by repeating the strict read.
    ///        A distrusted price is not a missing one: no caller may read
    ///        it as "unpriced", because the unpriced branch of the
    ///        failed-swap split hands the lender the whole collateral,
    ///        which would reward whoever caused the disagreement. The revert unwinds the whole close-out, which
    ///        can be retried once the feeds agree.
    ///      `priced` is the ONLY availability signal: a priced rate can still
    ///      convert a small amount to zero units, and that zero is a real
    ///      figure, never "unavailable" (#1281 item 027). `r` is zero when
    ///      `priced` is false.
    function tryOracleRate(
        address diamond,
        address collateralAsset,
        address principalAsset
    ) internal view returns (bool priced, Rate memory r) {
        (OracleFacet.PriceStatus colStatus, uint256 colPrice, uint8 colFeedDec) =
            OracleFacet(diamond).getAssetPriceStatus(collateralAsset);
        (OracleFacet.PriceStatus prinStatus, uint256 prinPrice, uint8 prinFeedDec) =
            OracleFacet(diamond).getAssetPriceStatus(principalAsset);
        if (
            colStatus == OracleFacet.PriceStatus.Unavailable ||
            prinStatus == OracleFacet.PriceStatus.Unavailable
        ) return (false, r);
        if (
            colStatus == OracleFacet.PriceStatus.Divergent ||
            prinStatus == OracleFacet.PriceStatus.Divergent
        ) {
            // The strict read of the distrusted leg repeats the read just
            // classified, in this transaction, so it raises the same error;
            // the trailing revert only keeps the refusal unconditional.
            OracleFacet(diamond).getAssetPrice(
                colStatus == OracleFacet.PriceStatus.Divergent ? collateralAsset : principalAsset
            );
            revert OracleFacet.OraclePriceDivergence();
        }
        if (colPrice == 0 || prinPrice == 0) return (false, r);
        return (true, _rate(collateralAsset, principalAsset, colPrice, colFeedDec, prinPrice, prinFeedDec));
    }

    /// @dev Collateral units for `principalAmount` at `r`. Pass `Ceil` for the
    ///      collateral NEEDED to cover an amount owed (it never falls short of
    ///      the amount at this rate), `Floor` for the collateral an amount is
    ///      WORTH.
    function toCollateral(Rate memory r, uint256 principalAmount, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        uint256 scaled = principalAmount * r.num;
        return Math.unsignedRoundsUp(rounding) ? Math.ceilDiv(scaled, r.den) : scaled / r.den;
    }

    /// @dev Principal-asset value of `collateralAmount` at `r`, rounded down.
    function toPrincipal(Rate memory r, uint256 collateralAmount) internal pure returns (uint256) {
        return (collateralAmount * r.den) / r.num;
    }

    /// @dev Oracle-derived expected swap output in principal-asset token
    ///      units. Assumes both assets are liquid (caller must verify).
    ///      Reverts on a missing or stale feed ({oracleRate}).
    function expectedSwapOutput(
        address diamond,
        address collateralAsset,
        address principalAsset,
        uint256 collateralAmount
    ) internal view returns (uint256) {
        Rate memory r = oracleRate(diamond, collateralAsset, principalAsset);
        // The ordinary reader refuses a non-positive price, so a zero principal
        // price cannot reach here on a live oracle; kept as the original guard.
        if (r.num == 0) return 0;
        return toPrincipal(r, collateralAmount);
    }

    /// @dev Collateral units for `principalAmount` at the current oracle
    ///      ({tryOracleRate}): `priced` is false when either leg is
    ///      unavailable, so a caller can route to the oracle-unavailable
    ///      branch instead of having the whole liquidation revert. A
    ///      distrusted price reverts with its read's own divergence error
    ///      (#666). `rounding` as in {toCollateral}.
    function collateralEquivalent(
        address diamond,
        uint256 principalAmount,
        address collateralAsset,
        address principalAsset,
        Math.Rounding rounding
    ) internal view returns (bool priced, uint256 collateralAmount) {
        Rate memory r;
        (priced, r) = tryOracleRate(diamond, collateralAsset, principalAsset);
        if (priced) collateralAmount = toCollateral(r, principalAmount, rounding);
    }

    /// @notice The principal-asset VALUE of `collateralAmount` at the current
    ///         oracle (the inverse of {collateralEquivalent}), rounded down.
    /// @dev `priced` is false if either leg's oracle is unavailable, so a
    ///      caller refuses on `!priced` rather than on a zero value; a
    ///      distrusted price reverts with its read's own divergence error
    ///      (#666). Used by
    ///      the #399 backstop Role-B par-guard to check the lender slice's
    ///      value directly (`value >= lenderPrincipalDue`).
    function principalEquivalent(
        address diamond,
        uint256 collateralAmount,
        address collateralAsset,
        address principalAsset
    ) internal view returns (bool priced, uint256 principalValue) {
        Rate memory r;
        (priced, r) = tryOracleRate(diamond, collateralAsset, principalAsset);
        if (priced) principalValue = toPrincipal(r, collateralAmount);
    }

    /// @dev The fraction from two positive prices and both tokens' decimals.
    function _rate(
        address collateralAsset,
        address principalAsset,
        uint256 colPrice,
        uint8 colFeedDec,
        uint256 prinPrice,
        uint8 prinFeedDec
    ) private view returns (Rate memory r) {
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        r.num = prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec);
        r.den = colPrice * (10 ** prinTokenDec) * (10 ** prinFeedDec);
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
    ///      Rounding is lender first: the lender slice is the collateral
    ///      NEEDED to cover `lenderPrincipalDue`, rounded up, so at the entry
    ///      price it is never worth less than the due; the treasury slice is
    ///      rounded down, and the borrower takes the remainder.
    ///
    ///      `oracleAvailable` comes from the price reads themselves
    ///      ({tryOracleRate}), one reading for both slices. When either leg
    ///      has no price at all the split is the full-collateral-to-lender
    ///      branch and the flag is false, so callers emit the
    ///      oracle-unavailable event. A priced split is never read as an
    ///      oracle failure, however small its slices (#1281 item 027).
    ///      When a leg's price exists but the sources it is checked against
    ///      disagree, the split is refused (the read's own divergence
    ///      error, #666) rather than
    ///      priced as unavailable: the fallback entry reverts, so the
    ///      liquidation or default that reached it is undone and can be
    ///      retried once the feeds agree.
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

        (bool priced, Rate memory r) = tryOracleRate(
            diamond,
            loan.collateralAsset,
            loan.principalAsset
        );
        oracleAvailable = priced;
        if (!priced) {
            // Full collateral to lender; treasury + borrower zeroed. Same
            // numbers as the "collateral insufficient" branch below, but
            // reached because nothing can be priced, not because the
            // lender's claim is large.
            return (
                loan.collateralAmount,
                0,
                0,
                lenderPrincipalDue,
                treasuryPrincipalDue,
                false
            );
        }
        uint256 lenderCol = toCollateral(r, lenderPrincipalDue, Math.Rounding.Ceil);
        uint256 treasuryCol = toCollateral(r, treasuryPrincipalDue, Math.Rounding.Floor);

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
