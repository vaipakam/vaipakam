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
import { positionNftSurfaceForDiamond, positionOwnerOfCall, positionRouteCall, type PositionNftSurface } from '@vaipakam/lib/positionNft';

/** The surface of the chain whose Diamond is `diamond`; throws when no
 *  record names it, so a caller never guesses the mode. */
export function positionNftForDiamond(diamond: string): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}`);
  return s;
}

/** `ownerOf` on the contract holding the chain's position NFTs. */
export function positionOwnerCall(diamond: string, tokenId: bigint) {
  return positionOwnerOfCall(positionNftForDiamond(diamond), tokenId);
}

/** The open route on `tokenId` (`positionRoute`, or the legacy `positionLock`). */
export function positionRouteCallFor(diamond: string, tokenId: bigint) {
  return positionRouteCall(positionNftForDiamond(diamond), tokenId);
}
