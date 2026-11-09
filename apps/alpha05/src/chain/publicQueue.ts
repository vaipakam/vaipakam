/**
 * Which networks hold a sent transaction in a public queue before it is
 * included (#3357, RB-PUBLIC-QUEUE). On these, anyone watching the queue,
 * bots included, sees a cancel, a repayment or added collateral before it
 * lands and can act first: take the offer being cancelled, or act on the
 * loan being rescued. The single-sequencer rollups this app serves (Base,
 * Arbitrum, Optimism and their test networks) keep no public queue, so
 * nothing is said there. BNB Testnet is listed with BNB Chain because it
 * runs the same way, and it is where the notice can be seen before
 * mainnet. The app names no private sending service: it says what is
 * exposed and points to the guide.
 */
export const PUBLIC_QUEUE_CHAIN_IDS: ReadonlySet<number> = new Set([1, 56, 97]);

/** Whether a transaction sent on `chainId` waits in a public queue. */
export function hasPublicQueue(chainId: number): boolean {
  return PUBLIC_QUEUE_CHAIN_IDS.has(chainId);
}
