/**
 * The gas limit a transaction is sent with — the one rule, for every sender.
 *
 * ── Why a node's estimate is not a gas limit ─────────────────────────
 *
 * `eth_estimateGas` binary-searches for the LOWEST limit at which the call
 * succeeds, so its answer carries no margin at all. And it runs the call in
 * the LATEST block's environment: that block's timestamp and number. The
 * transaction then mines in a later block, at a later timestamp. A call
 * whose cost depends on how much time has passed costs more when mined than
 * when estimated, and at a zero-margin limit any extra gas is fatal.
 *
 * The protocol has such paths. A CCIP token pool's rate limiter refills and
 * re-stamps its bucket only when `block.timestamp` has moved since the last
 * stamp, so a send estimated in the second of the last stamp and mined in
 * the next one does extra work. When the shortfall lands inside a nested
 * call, that call runs out of gas under the 63/64 rule and the outer call
 * reverts with no reason, at about 98.5% of the limit (#2997).
 *
 * Measured on anvil 1.5.1: a call that writes five slots only when the
 * timestamp has moved estimates at 23,306 gas a second after the stamp
 * (the cheap path, at the latest block's time) and reverts when mined with
 * that limit; with a block override naming the mined timestamp it
 * estimates at 52,639. A node on a live chain estimates against its latest
 * block the same way, and the next block is always later.
 *
 * ── Why a margin, and why this one ───────────────────────────────────
 *
 * The block a transaction lands in is not known when it is estimated, so
 * no estimate can be taken in its environment; a margin is the only
 * protection that works on every chain and every node. Unused gas is not
 * charged, so the margin costs nothing when it is not needed. 30% is the
 * margin `forge script` applies by default to every broadcast this
 * repository's deploy scripts make, so the contracts already reach every
 * chain under it. It is a bound on the drift seen so far (well under 2%
 * on #2997), not a proof of every future path: a call that still runs out
 * of gas fails loudly, with its revert, and is a reason to look at that
 * path rather than to raise the margin silently.
 */

/** The margin added to a node's estimate, in percent. */
export const GAS_LIMIT_MARGIN_PCT = 30n;

/**
 * The gas limit to send a transaction with, from the node's estimate:
 * the estimate plus {@link GAS_LIMIT_MARGIN_PCT}, rounded up.
 */
export function gasLimitFromEstimate(estimate: bigint): bigint {
  if (estimate < 0n) throw new RangeError(`gasLimitFromEstimate: a negative estimate (${estimate})`);
  return (estimate * (100n + GAS_LIMIT_MARGIN_PCT) + 99n) / 100n;
}
