/**
 * #642 — pure helpers for the keeper's in-tick partial-liquidation re-size /
 * cap-clamp retry loop. Kept side-effect-free (no RPC, no env) so the sizing
 * math is unit-testable in isolation (pairs with #222).
 *
 * Context: `RiskFacet.triggerPartialLiquidation(loanId, fractionBps, calls)`
 * reverts when the requested slice is mis-sized:
 *   - `PartialOverLiquidates`   — the slice would push HF past the on-chain
 *     over-liquidation ceiling. A SMALLER slice can still restore HF, so the
 *     keeper reduces the fraction, re-quotes, and retries in-tick.
 *   - `InvalidPartialFraction`  — the slice exceeds the governance close-factor
 *     cap (`maxPartialLiquidationCloseFactorBps`). The keeper reads the live cap
 *     and CLAMPS to it rather than escalating straight to full.
 */

/** Basis-point denominator (100% == 10_000 BPS). */
export const BPS = 10_000n;

/**
 * Smallest slice worth attempting. Below this a partial barely moves HF and just
 * burns gas/quotes, so the keeper stops re-sizing and lets the loan escalate to
 * full (or recompute next tick). 5% of the loan.
 */
export const MIN_PARTIAL_FRACTION_BPS = 500n;

/**
 * Reduce an over-sized partial fraction for the next retry. A `PartialOverLiquidates`
 * revert means the on-chain ceiling is tighter than the keeper's estimate; shrink
 * by 25% each attempt so a bounded handful of retries converges under it without
 * collapsing to a dust slice. Never returns below 1 BPS for a positive input.
 */
export function reducePartialFractionBps(currentBps: bigint): bigint {
  if (currentBps <= 0n) return 0n;
  const reduced = (currentBps * 3n) / 4n;
  return reduced > 0n ? reduced : 1n;
}

/**
 * Clamp a requested fraction to the on-chain close-factor cap. Returns the
 * smaller of the two; if the cap is already ≥ the request, the request is
 * returned unchanged (the cap isn't the binding constraint).
 */
export function clampPartialFractionBps(currentBps: bigint, capBps: bigint): bigint {
  return currentBps > capBps ? capBps : currentBps;
}

/**
 * Collateral sell-amount for a given fraction of the loan's collateral — the
 * `sellAmount` the keeper re-quotes the swap route for when it changes the slice.
 */
export function sellAmountForFractionBps(
  collateralAmount: bigint,
  fractionBps: bigint,
): bigint {
  return (collateralAmount * fractionBps) / BPS;
}

/**
 * Normalize a close-factor cap read off-chain into a usable BPS value. A `0`
 * sentinel (or anything out of the 1..10_000 range / a failed read) means "no
 * cap" → full 10_000.
 */
export function normalizeCloseFactorCapBps(raw: bigint): bigint {
  return raw > 0n && raw <= BPS ? raw : BPS;
}
