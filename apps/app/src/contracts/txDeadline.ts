/**
 * The transaction deadline every price-exposed Diamond write carries (#3412)
 * — the app's one reader of it.
 *
 * Posting or changing an offer or a standing intent, a swap-to-repay, a sale
 * listing or a direct sale, an offset and an obligation handover each take a
 * mandatory trailing `validUntil`. The chain refuses the transaction if it
 * lands after that second (`DeadlinePassed`), so a transaction that waited in
 * a queue never executes on a market the user no longer agreed to.
 *
 * The window is the shared rule in `@vaipakam/lib/txDeadline`, and it is
 * measured from the CHAIN's latest block time, never the device clock: the
 * contract compares against `block.timestamp`, and a device clock (or a local
 * test chain's) can be well off it. Read it as late as possible — right
 * before the arguments are built for the send — not when the page loads.
 */
import { maxUint64 } from 'viem';
import { txValidUntil } from '@vaipakam/lib/txDeadline';

/** The one read this needs from a chain client. Structural, so any viem or
 *  wagmi public client satisfies it, and a test can hand in a stub. */
export interface ChainClock {
  getBlock(args: { blockTag: 'latest' }): Promise<{ timestamp: bigint }>;
}

/**
 * The `validUntil` for a price-exposed transaction about to be sent: the
 * chain's latest block time plus the shared window.
 */
export async function readTxValidUntil(client: ChainClock): Promise<bigint> {
  const latest = await client.getBlock({ blockTag: 'latest' });
  return txValidUntil(latest.timestamp);
}

/**
 * The deadline written into an ADVISORY pre-sign dry run (`useTxSimulation`)
 * that is built while the page renders. Such a call is an `eth_call` and is
 * never sent, so its deadline cannot be the one the transaction carries; a
 * fixed far value keeps the previewed calldata stable from block to block
 * (the preview re-runs whenever its calldata changes) and lets the dry run
 * report every OTHER refusal. The transaction itself always carries
 * `readTxValidUntil`, read at the send.
 */
export const PREVIEW_VALID_UNTIL: bigint = maxUint64;
