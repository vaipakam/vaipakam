/**
 * #3205 — alpha05's ONE door to the position NFTs: owners and the open route
 * are read under the chain's mode (the standalone PositionNFT, or the
 * pre-#3205 Diamond), decided from the deployment record that names the
 * Diamond. The rule and the frozen legacy fragment live in
 * `@vaipakam/lib/positionNft`.
 *
 * TODO(#3321 positionNft-legacy-removal): the legacy (Diamond) branch is
 * deleted at the all-waves fresh deploy.
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
 *  record names it, so a caller never guesses the mode. */
export function positionNftForDiamond(diamond: string): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}`);
  return s;
}

/** The LIVE holder of `tokenId` (both reads at `blockNumber`). Throws as a
 *  pre-#3205 `ownerOf` did: a revert for a never-minted or burned token, a
 *  `PositionRetiredError` for a retired one, a transport failure as itself. */
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
 *  minted or burned, or a retired token), and a thrown error when the source
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

/** The open route on `tokenId` (`positionRoute`, or the legacy `positionLock`). */
export function positionRouteCallFor(diamond: string, tokenId: bigint) {
  return positionRouteCall(positionNftForDiamond(diamond), tokenId);
}
