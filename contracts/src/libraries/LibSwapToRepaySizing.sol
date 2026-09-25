// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFallback} from "./LibFallback.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
     * @notice The least collateral, up to rounding worth at most a few base
     *         units of the principal asset, whose slippage-capped oracle floor
     *         covers `required`, bounded by `maxIn`.
     * @dev    `floor(x) = expectedSwapOutput(x) × (BPS − cap) / BPS` is linear
     *         in `x` up to two floored divisions, so the ceiling of
     *         `required × maxIn / floor(maxIn)` is exact in real arithmetic and
     *         at most a few units short after rounding. The short case steps up
     *         by the ceiling of the remaining deficit, and falls back to `maxIn`
     *         — whose floor is already known to cover `required` — so a
     *         covering result ALWAYS clears `required` and never exceeds
     *         `maxIn`.
     * @param collateralAsset The asset being sold.
     * @param principalAsset  The asset the sale must raise.
     * @param required        Principal the worst-case proceeds must cover.
     * @param maxIn           The caller's upper bound on collateral sold.
     * @return covers False when even `maxIn` cannot cover `required` at the
     *                slippage floor; the caller refuses with its own error and
     *                `sell` / `floor` are then zero.
     * @return sell   Collateral to sell (`<= maxIn`).
     * @return floor  The slippage-capped floor for `sell` (`>= required`).
     */
    function sizeSale(
        address collateralAsset,
        address principalAsset,
        uint256 required,
        uint256 maxIn
    ) internal view returns (bool covers, uint256 sell, uint256 floor) {
        uint256 floorAtMax = slippageFloor(collateralAsset, principalAsset, maxIn);
        if (floorAtMax < required) return (false, 0, 0);
        sell = Math.mulDiv(required, maxIn, floorAtMax, Math.Rounding.Ceil);
        floor = slippageFloor(collateralAsset, principalAsset, sell);
        for (uint256 i; i < 2 && floor < required; ++i) {
            sell += Math.mulDiv(required - floor, maxIn, floorAtMax, Math.Rounding.Ceil);
            if (sell >= maxIn) break;
            floor = slippageFloor(collateralAsset, principalAsset, sell);
        }
        if (sell >= maxIn || floor < required) return (true, maxIn, floorAtMax);
        return (true, sell, floor);
    }

    /// @notice Slippage-capped oracle floor for selling `amount` collateral.
    function slippageFloor(address collateralAsset, address principalAsset, uint256 amount)
        internal
        view
        returns (uint256)
    {
        return (LibFallback.expectedSwapOutput(address(this), collateralAsset, principalAsset, amount) *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;
    }
}
