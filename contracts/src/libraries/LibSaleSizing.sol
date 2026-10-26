// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFallback} from "./LibFallback.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title  LibSaleSizing
 * @notice The ONE rule for how much collateral a sale may sell when it only
 *         has to raise a known amount: the least collateral whose worst-case
 *         proceeds cover it (#2317, #2322, #2795).
 * @dev    Every sell-to-need path sizes through here, each with its own
 *         slippage cap, so no two of them can answer the same question
 *         differently:
 *         - the voluntary full swap-to-repay ({SwapToRepayFacet.swapToRepayFull},
 *           sized to the payoff) and the resolver-filled intent
 *           ({SwapToRepayIntentFacet.commitSwapToRepayIntent}, the auction lot
 *           sized to the order's minimum taker amount), at the borrower-facing
 *           `cfgMaxSwapToRepaySlippageBps`;
 *         - the forced sales ({ForcedSaleFacet}, sized to the debt plus the
 *           largest charges), at `cfgMaxLiquidationSlippageBps`.
 *         The caller's bound is an UPPER bound, never the sale size;
 *         collateral the sale does not need stays pledged in the borrower's
 *         vault.
 *
 *         "Worst-case proceeds" is the oracle value of the sale less the
 *         caller's slippage cap.
 */
library LibSaleSizing {
    /**
     * @notice The least collateral whose slippage-capped oracle floor covers
     *         `required`, bounded by `maxIn` — EXACTLY the least, whatever the
     *         two tokens' decimals and prices.
     * @dev    The floor is two floored divisions, and it inverts exactly
     *         (Codex #2341 r5 — an earlier approximate-then-step-up version
     *         could overshoot by far more than "a few base units" when the
     *         principal token is coarse, e.g. auctioning 149 collateral units
     *         where 100 already met the same floor). With
     *           A / B = colPrice · 10^(prinTokenDec + prinFeedDec)
     *                 / prinPrice · 10^(colTokenDec + colFeedDec)
     *           (the oracle rate's `den / num`, {LibFallback.oracleRate},
     *           with the shared power of ten cancelled)
     *           E(x) = ⌊x·A / B⌋                      (= expectedSwapOutput)
     *           floor(x) = ⌊E(x)·K / BPS⌋,  K = BPS − cap
     *         both floors are monotone, so
     *           floor(x) ≥ R  ⇔  E(x) ≥ ⌈R·BPS / K⌉ =: Emin
     *                         ⇔  x·A ≥ Emin·B
     *                         ⇔  x ≥ ⌈Emin·B / A⌉,
     *         and the least covering amount is that ceiling. The prices and
     *         decimals are read once, as the one oracle rate
     *         ({LibFallback.oracleRate}) that `LibFallback.expectedSwapOutput`
     *         also reads, so the answer agrees with the floor enforcement
     *         checks. `mulDiv` keeps every product exact.
     * @param collateralAsset The asset being sold.
     * @param principalAsset  The asset the sale must raise.
     * @param required        Principal the worst-case proceeds must cover.
     * @param maxIn           The caller's upper bound on collateral sold.
     * @param capBps          The slippage cap the sale is held to (bps, `< BPS`).
     * @return covers False when even `maxIn` cannot cover `required` at the
     *                slippage floor (or an oracle price is zero); the caller
     *                refuses with its own error and `sell` / `floor` are then
     *                zero.
     * @return sell   Collateral to sell: the least covering amount (`<= maxIn`).
     * @return floor  The slippage-capped floor for `sell` (`>= required`).
     */
    function sizeSale(
        address collateralAsset,
        address principalAsset,
        uint256 required,
        uint256 maxIn,
        uint256 capBps
    ) internal view returns (bool covers, uint256 sell, uint256 floor) {
        return sizeSaleAtRate(
            LibFallback.oracleRate(address(this), collateralAsset, principalAsset), required, maxIn, capBps
        );
    }

    /// @notice {sizeSale} at a rate the caller already read
    ///         ({LibFallback.oracleRate}), so a caller that quotes its sale at
    ///         that same rate sizes and quotes from ONE reading. The rate's
    ///         `toPrincipal(x) = ⌊x·den / num⌋` is the `E(x)` above with
    ///         `A = den`, `B = num`.
    function sizeSaleAtRate(
        LibFallback.Rate memory rate,
        uint256 required,
        uint256 maxIn,
        uint256 capBps
    ) internal pure returns (bool covers, uint256 sell, uint256 floor) {
        return _size(rate.den, rate.num, required, maxIn, capBps);
    }

    /// @notice The slippage-capped floor of selling `amount` at `rate` —
    ///         the same floor {sizeSaleAtRate} guarantees, for an amount the
    ///         caller did not size (an uncovered sale of everything, or what
    ///         actually arrived).
    function floorAtRate(LibFallback.Rate memory rate, uint256 amount, uint256 capBps)
        internal
        pure
        returns (uint256)
    {
        if (rate.num == 0) return 0;
        return (LibFallback.toPrincipal(rate, amount) * (LibVaipakam.BASIS_POINTS - capBps))
            / LibVaipakam.BASIS_POINTS;
    }

    function _size(uint256 a, uint256 b, uint256 required, uint256 maxIn, uint256 capBps)
        private
        pure
        returns (bool covers, uint256 sell, uint256 floor)
    {
        if (a == 0 || b == 0 || capBps >= LibVaipakam.BASIS_POINTS) return (false, 0, 0);
        uint256 k = LibVaipakam.BASIS_POINTS - capBps;
        uint256 eMin = Math.mulDiv(required, LibVaipakam.BASIS_POINTS, k, Math.Rounding.Ceil);
        sell = Math.mulDiv(eMin, b, a, Math.Rounding.Ceil);
        if (sell > maxIn) return (false, 0, 0);
        floor = (Math.mulDiv(sell, a, b) * k) / LibVaipakam.BASIS_POINTS;
        covers = true;
    }
}
