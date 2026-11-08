/**
 * #3205 — a position NFT's holder, read from the contract that holds the
 * chain's position NFTs: the standalone PositionNFT where the deployments
 * bundle records one, else the pre-#3205 Diamond. The rule is the app's own
 * (`@vaipakam/lib/positionNft`); this only binds it to a driver's client.
 *
 * TODO(#3321 positionNft-legacy-removal): the Diamond fallback goes with the
 * legacy mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionNftSurface, positionOwnerOfCall, positionRouteCall } from '@vaipakam/lib/positionNft';

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/contracts/src/deployments.json');

/** The chain's position-NFT surface, from the committed bundle. */
export function positionSurfaceFor(chainId) {
  const d = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'))[String(chainId)];
  if (!d?.diamond) throw new Error(`deployments bundle has no Diamond for chain ${chainId}`);
  return positionNftSurface(d);
}

/** `(tokenId, blockNumber?) => holder`: `ownerOf` on that contract. Throws
 *  exactly as the read does (a revert, or a transport failure). */
export function positionHolderReader(pub, chainId) {
  const surface = positionSurfaceFor(chainId);
  return (tokenId, blockNumber) =>
    pub.readContract({ ...positionOwnerOfCall(surface, tokenId), ...(blockNumber === undefined ? {} : { blockNumber }) });
}

/** `(tokenId, blockNumber?) => route ordinal`: the open protocol route,
 *  `positionRoute` (standalone) or the legacy `positionLock`. */
export function positionRouteReader(pub, chainId) {
  const surface = positionSurfaceFor(chainId);
  return async (tokenId, blockNumber) =>
    Number(
      await pub.readContract({ ...positionRouteCall(surface, tokenId), ...(blockNumber === undefined ? {} : { blockNumber }) }),
    );
}
