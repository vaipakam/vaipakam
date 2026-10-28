/**
 * The app's one way to read several calls as ONE snapshot: Multicall3's
 * `aggregate3`, through `@vaipakam/lib/multicall`'s `aggregateReads`.
 *
 * Use it, not viem's `multicall({ allowFailure: true })`, wherever a failed
 * slot is read as the chain's answer. viem fails every slot of a request
 * that did not complete with the same `failure` status a revert gets, and
 * may split a plan across requests (so across blocks); `aggregateReads`
 * rejects on a provider failure and reads the whole plan in one `eth_call`.
 */
import { aggregateReads, type AggregateRead, type AggregateSlot } from '@vaipakam/lib/multicall';
import type { Address, PublicClient } from 'viem';

export type { AggregateRead, AggregateSlot };

/**
 * The chain's Multicall3. Every chain this app supports carries the
 * canonical one in its viem definition, so a chain without one is a
 * configuration error, thrown rather than worked around with a second code
 * path that reads call by call.
 */
export function multicall3Of(publicClient: Pick<PublicClient, 'chain'>): Address {
  const address = publicClient.chain?.contracts?.multicall3?.address;
  if (!address) {
    throw new Error(`no Multicall3 configured for chain ${publicClient.chain?.id ?? '(none)'}`);
  }
  return address;
}

/** `reads` as one aggregate on the client's chain — see the module note. */
export function readAggregate(
  publicClient: Pick<PublicClient, 'chain' | 'readContract'>,
  reads: readonly AggregateRead[],
): Promise<AggregateSlot[]> {
  return aggregateReads(publicClient, multicall3Of(publicClient), reads);
}
