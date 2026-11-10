/**
 * NFT-02 / NFT-04 — the chain reads a rental stands on, through the
 * connected wallet's own connection: the buffer share the listing recorded
 * when it was posted and the protocol's buffer setting today. A rental's
 * user right is read from its transaction's own log (rentalLog.ts).
 */
import type { PublicClient } from 'viem';
import type { AtBlock } from '../tx/anchored';
import { CONFIG, OFFER_CANCEL } from '../offers/reads';

type Hex = `0x${string}`;

const at = (b?: AtBlock) => (b ? { blockNumber: b.blockNumber } : {});

/** The buffer share (bps) the listing recorded when it was posted; zero for
 *  a listing posted before listings recorded it. */
export async function readListingBufferBps(client: PublicClient, diamond: Hex, offerId: bigint, b?: AtBlock): Promise<bigint> {
  const raw = (await client.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOffer', args: [offerId], ...at(b) })) as { rentalBufferBpsAtCreate?: number | bigint };
  return BigInt(raw.rentalBufferBpsAtCreate ?? 0);
}

/** The protocol's rental buffer setting now (bps). */
export async function readTodayBufferBps(client: PublicClient, diamond: Hex, b?: AtBlock): Promise<bigint> {
  const [, bufferBps] = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getRiskConfig', ...at(b) })) as readonly [bigint, bigint];
  return bufferBps;
}
