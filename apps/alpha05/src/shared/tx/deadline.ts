/**
 * #3412 — the deadline every price-exposed transaction carries, read from
 * the chain's clock. The rule (thirty minutes from the latest block) is the
 * shared one in `@vaipakam/lib/txDeadline`; this module only reads the
 * chain's time for it, so a post, a listing or a request never carries a
 * deadline measured on the device clock (which can be minutes off, and a
 * local test chain's clock moves on its own).
 *
 * The deadline is read right before the call's arguments are built: the
 * dry run reads its own, and the write reads one again, so a review left
 * open never sends a deadline that has already run down.
 */
import type { PublicClient } from 'viem';
import { txValidUntil } from '@vaipakam/lib/txDeadline';
import type { OwnStateClient } from '../../chain/ownRail';

export { TX_DEADLINE_SECONDS, txValidUntil } from '@vaipakam/lib/txDeadline';

/** The `validUntil` for a call built now, from this client's latest block. */
export async function chainValidUntil(c: PublicClient): Promise<bigint> {
  const block = await c.getBlock({ blockTag: 'latest' });
  return txValidUntil(block.timestamp);
}

/** The `validUntil` for a call built now, read through the own rail. */
export async function readValidUntil(own: Pick<OwnStateClient, 'read'>): Promise<bigint> {
  return (await own.read(chainValidUntil)).value;
}
