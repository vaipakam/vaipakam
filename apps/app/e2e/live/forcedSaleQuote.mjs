/**
 * The collateral amount a live drive quotes a forced close-out for (#2796).
 *
 * `triggerDefault(loanId, sellAmount, adapterCalls)` refuses, before
 * anything moves, a sale whose `sellAmount` lies outside the range
 * `previewForcedSale(loanId, TimeBasedDefault)` publishes. A drive that
 * probes the close-out with an empty try-list must therefore quote inside
 * that range, or the probe stops at `ForcedSaleQuoteOutOfRange` instead of
 * the `NoEnabledSwapRoute` it is asking about.
 *
 * The rule is the app's own (`forcedSaleQuoteAmount` in
 * `@vaipakam/lib/routeBuilder`: the middle of the range, or nothing when no
 * sale is due). It is restated here because the drives run under plain
 * Node, which cannot import that TypeScript source;
 * `forcedSaleQuote.test.mjs` pins the two to the same answers.
 */

/** `ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault`. */
export const TIME_BASED_DEFAULT = 3;

/**
 * The amount to quote for a plan, or `0n` when the plan says no sale is due.
 * `0n` is what the card sends then too: the contract reads the amount only
 * on the liquid sale route, which a plan with no sale never reaches.
 *
 * @param {{ sell: bigint, maxSell: bigint }} plan
 * @returns {bigint}
 */
export function quoteFromPlan(plan) {
  if (plan.sell === 0n) return 0n;
  return plan.sell + (plan.maxSell - plan.sell) / 2n;
}

/**
 * Read the default's sale plan from the Diamond and quote it.
 *
 * @param {{ readContract: Function }} pub a viem public client
 * @param {`0x${string}`} diamond
 * @param {readonly unknown[]} abi an ABI carrying `previewForcedSale`
 * @param {bigint} loanId
 * @param {bigint} [blockNumber] read at this block when given
 * @returns {Promise<bigint>}
 */
export async function readDefaultQuote(pub, diamond, abi, loanId, blockNumber) {
  const plan = await pub.readContract({
    address: diamond,
    abi,
    functionName: 'previewForcedSale',
    args: [loanId, TIME_BASED_DEFAULT],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });
  return quoteFromPlan(plan);
}
