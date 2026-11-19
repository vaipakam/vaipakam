/**
 * #3205 — alpha05's ONE door to the position NFTs: owners are read at the
 * PositionNFT and the open route at the Diamond, both named by the deployment
 * record of the Diamond. The rule lives in `@vaipakam/lib/positionNft`, which
 * refuses a record without `positionNFT` (#3321).
 */
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import {
  PositionRetiredError,
  positionNftSurfaceForDiamond,
  positionRouteCall,
  readPositionOwner,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';
import { answerOrNull } from '../reads/answer';

/** The surface of the chain whose Diamond is `diamond`; throws when no
 *  record names it, or when its record names no PositionNFT. */
export function positionNftForDiamond(diamond: string): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}`);
  return s;
}

/** The LIVE holder of `tokenId` (both reads at `blockNumber`). Throws a
 *  revert for a never-minted token, a `PositionRetiredError` for a retired
 *  one, a transport failure as itself. */
export function readPositionOwnerFor(
  client: { readContract: (args: any) => Promise<unknown> },
  diamond: string,
  tokenId: bigint,
  blockNumber?: bigint,
): Promise<`0x${string}`> {
  return readPositionOwner(client, positionNftForDiamond(diamond), tokenId, blockNumber);
}

/** The LIVE holder of `tokenId` under the one read rule (`answerOrNull`):
 *  `null` when the contract answers there is none (a revert for a token never
 *  minted, or a retired token), and a thrown error when the source
 *  itself failed, so the own rail moves on to its next source. */
export async function readLiveHolderOrNull(
  client: { readContract: (args: any) => Promise<unknown> },
  diamond: string,
  tokenId: bigint,
  blockNumber?: bigint,
): Promise<`0x${string}` | null> {
  try {
    return await answerOrNull(readPositionOwnerFor(client, diamond, tokenId, blockNumber));
  } catch (e) {
    if (e instanceof PositionRetiredError) return null;
    throw e;
  }
}

/** The open route on `tokenId` (`positionRoute` on the Diamond). */
export function positionRouteCallFor(diamond: string, tokenId: bigint) {
  return positionRouteCall(positionNftForDiamond(diamond), tokenId);
}
