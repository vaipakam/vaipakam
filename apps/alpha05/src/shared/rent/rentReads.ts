/**
 * NFT-02 / NFT-04 — the chain reads a rental stands on, through the
 * connected wallet's own connection: the buffer share the listing recorded
 * when it was posted, the protocol's buffer setting today, and, after a
 * rental starts, who the owner's vault names as the NFT's user and until
 * when.
 */
import type { PublicClient } from 'viem';
import type { AtBlock } from '../tx/anchored';
import { CONFIG, OFFER_CANCEL, VAULT_FACTORY } from '../offers/reads';

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

export interface RentalUse {
  /** The first renter still active on this NFT in the owner's vault. */
  user: Hex;
  /** The earliest active expiry, unix seconds; 0 when none is active. */
  expires: bigint;
  /** The quantity rented out now, summed across active rentals. */
  quantity: bigint;
}

/** Who the owner's vault names as the NFT's user, at a block. */
export async function readRentalUse(client: PublicClient, diamond: Hex, owner: Hex, nft: Hex, tokenId: bigint, b?: AtBlock): Promise<RentalUse> {
  const args = [owner, nft, tokenId] as const;
  const [user, expires, quantity] = await Promise.all([
    client.readContract({ address: diamond, abi: VAULT_FACTORY, functionName: 'vaultGetNFTUserOf', args, ...at(b) }) as Promise<Hex>,
    client.readContract({ address: diamond, abi: VAULT_FACTORY, functionName: 'vaultGetNFTUserExpires', args, ...at(b) }) as Promise<bigint | number>,
    client.readContract({ address: diamond, abi: VAULT_FACTORY, functionName: 'vaultGetNFTQuantity', args, ...at(b) }) as Promise<bigint>,
  ]);
  return { user, expires: BigInt(expires), quantity };
}
