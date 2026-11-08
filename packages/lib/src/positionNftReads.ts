/**
 * #3205 — the position-NFT reads every surface shares, over either mode
 * (`positionNft.mjs`). The client is typed structurally so callers on another
 * physical copy of viem pass theirs unchanged (see `contractRevert`).
 *
 * TODO(#3321 positionNft-legacy-removal): drop the legacy branches with the
 * legacy mode.
 */
import {
  positionOwnerOfCall,
  positionRetiredCall,
  positionRouteCall,
  type PositionNftSurface,
} from './positionNft.mjs';
import { isRevert } from './contractRevert';

export * from './positionNft.mjs';

/** Anything with viem's `readContract`. */
export interface ReadClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args: any) => Promise<unknown>;
}

/** The open route on `tokenId` as its ordinal (`POSITION_ROUTE`). Throws on
 *  any failure, so a caller decides how to fail closed. */
export async function readPositionRoute(
  client: ReadClient,
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
  blockNumber?: bigint,
): Promise<number> {
  return Number(await client.readContract({ ...positionRouteCall(surface, tokenId), blockNumber }));
}

/** `ownerOf(tokenId)`, as the chain answers it: throws on a revert or a
 *  transport failure. In standalone mode a retired token still has an owner;
 *  use {@link readPositionHolder} where a closed position must read as gone. */
export async function readPositionOwner(
  client: ReadClient,
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
  blockNumber?: bigint,
): Promise<`0x${string}`> {
  return (await client.readContract({ ...positionOwnerOfCall(surface, tokenId), blockNumber })) as `0x${string}`;
}

/**
 * Who holds the live position `tokenId`, or `'gone'` when the chain says it
 * no longer represents an open position: the token was never minted or was
 * burned (legacy, an `ownerOf` revert), or it was retired (standalone, where
 * a closed position's token keeps its owner). A transport failure THROWS: it
 * establishes nothing.
 */
export async function readPositionHolder(
  client: ReadClient,
  surface: PositionNftSurface,
  tokenId: bigint | number | string,
  blockNumber?: bigint,
): Promise<`0x${string}` | 'gone'> {
  const retiredCall = positionRetiredCall(surface, tokenId);
  const [owner, retired] = await Promise.all([
    readPositionOwner(client, surface, tokenId, blockNumber).catch((e: unknown) => {
      if (isRevert(e)) return 'gone' as const;
      throw e;
    }),
    retiredCall ? (client.readContract({ ...retiredCall, blockNumber }) as Promise<boolean>) : Promise.resolve(false),
  ]);
  return retired ? 'gone' : owner;
}
