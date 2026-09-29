// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title  LibSwapToRepaySizing
 * @notice The ONE rule for how much collateral a full swap-to-repay close
 *         may sell (#2317, #2322): only what the debt needs.
 * @dev    Both full-close paths size through here — the borrower-driven
 *         {SwapToRepayFacet.swapToRepayFull} (sale sized to the payoff) and
 *         the resolver-filled {SwapToRepayIntentFacet.commitSwapToRepayIntent}
 *         (auction lot sized to the order's minimum taker amount) — so the two
 *         cannot drift into different answers to the same question. The
 *         caller's bound is an UPPER bound, never the sale size; collateral
 *         the sale does not need stays pledged in the borrower's vault.
 *
 *         "Worst-case proceeds" is the oracle value of the sale less the
 *         borrower-facing swap-to-repay slippage cap
 *         (`cfgMaxSwapToRepaySlippageBps`), the same cap both paths enforce.
 */
library LibSwapToRepaySizing {
    /**
     * @notice The least collateral whose slippage-capped oracle floor covers
     *         `required`, bounded by `maxIn` — EXACTLY the least, whatever the
     *         two tokens' decimals and prices.
     * @dev    The floor is two floored divisions, and it inverts exactly
     *         (Codex #2341 r5 — an earlier approximate-then-step-up version
     *         could overshoot by far more than "a few base units" when the
     *         principal token is coarse, e.g. auctioning 149 collateral units
     *         where 100 already met the same floor). With
     *           A = colPrice · 10^prinTokenDec · 10^prinFeedDec
     *           B = prinPrice · 10^colTokenDec · 10^colFeedDec
     *           E(x) = ⌊x·A / B⌋                      (= expectedSwapOutput)
     *           floor(x) = ⌊E(x)·K / BPS⌋,  K = BPS − cap
     *         both floors are monotone, so
     *           floor(x) ≥ R  ⇔  E(x) ≥ ⌈R·BPS / K⌉ =: Emin
     *                         ⇔  x·A ≥ Emin·B
     *                         ⇔  x ≥ ⌈Emin·B / A⌉,
     *         and the least covering amount is that ceiling. The prices and
     *         decimals are read once, with the same getters and the same
     *         arithmetic as `LibFallback.expectedSwapOutput`, so the answer
     *         agrees with the floor enforcement checks. `mulDiv` keeps every
     *         product exact.
     * @param collateralAsset The asset being sold.
     * @param principalAsset  The asset the sale must raise.
     * @param required        Principal the worst-case proceeds must cover.
     * @param maxIn           The caller's upper bound on collateral sold.
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
        uint256 maxIn
    ) internal view returns (bool covers, uint256 sell, uint256 floor) {
        (uint256 a, uint256 b) = _conversion(collateralAsset, principalAsset);
        if (a == 0 || b == 0) return (false, 0, 0);
        uint256 k = LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps();
        uint256 eMin = Math.mulDiv(required, LibVaipakam.BASIS_POINTS, k, Math.Rounding.Ceil);
        sell = Math.mulDiv(eMin, b, a, Math.Rounding.Ceil);
        if (sell > maxIn) return (false, 0, 0);
        floor = (Math.mulDiv(sell, a, b) * k) / LibVaipakam.BASIS_POINTS;
        covers = true;
    }

    /// @dev The two sides of the oracle conversion `expectedSwapOutput`
    ///      applies (`x · a / b`), read once. `b == 0` (a zero principal
    ///      price) and `a == 0` (a zero collateral price) both mean the sale
    ///      cannot be valued, and {sizeSale} refuses.
    function _conversion(address collateralAsset, address principalAsset)
        private
        view
        returns (uint256 a, uint256 b)
    {
        (uint256 colPrice, uint8 colFeedDec) = OracleFacet(address(this)).getAssetPrice(collateralAsset);
        (uint256 prinPrice, uint8 prinFeedDec) = OracleFacet(address(this)).getAssetPrice(principalAsset);
        uint8 colTokenDec = IERC20Metadata(collateralAsset).decimals();
        uint8 prinTokenDec = IERC20Metadata(principalAsset).decimals();
        a = colPrice * (10 ** prinTokenDec) * (10 ** prinFeedDec);
        b = prinPrice * (10 ** colTokenDec) * (10 ** colFeedDec);
    }
}
