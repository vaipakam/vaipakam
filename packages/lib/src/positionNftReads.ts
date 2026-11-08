/**
 * #3205 — the position-NFT reads every surface shares, over either mode
 * (`positionNft.mjs`). The client is typed structurally so callers on another
 * physical copy of viem pass theirs unchanged (see `contractRevert`).
 *
 * TODO(#3321 positionNft-legacy-removal): drop the legacy branches with the
 * legacy mode.
 */
import {
  PositionRetiredError,
  positionRouteCall,
  readPositionOwner,
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
  try {
    return await readPositionOwner(client, surface, tokenId, blockNumber);
  } catch (e: unknown) {
    if (e instanceof PositionRetiredError || isRevert(e)) return 'gone';
    throw e;
  }
}
