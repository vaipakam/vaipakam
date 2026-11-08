/**
 * #3205 — the keeper's ONE door to the position NFTs. A chain's mode comes
 * from its deployment record: the standalone PositionNFT when the record
 * lists `positionNFT`, else the pre-#3205 Diamond. The rule and the frozen
 * legacy fragment live in `@vaipakam/lib/positionNft`.
 *
 * TODO(#3321 positionNft-legacy-removal): the legacy (Diamond) branch is
 * deleted at the all-waves fresh deploy.
 */
import type { Address } from 'viem';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import { positionNftSurface, positionNftSurfaceForDiamond, type PositionNftSurface } from '@vaipakam/lib/positionNft';

export {
  LEGACY_DIAMOND_NFT_ABI,
  POSITION_ERC721_ABI,
  positionHolderCalls,
  positionHolderFrom,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';

/** The surface of the chain whose Diamond is `diamond`. A Diamond no record
 *  names is read as legacy — the only contract the keeper was given. */
export function positionNftForDiamond(diamond: Address): PositionNftSurface {
  return positionNftSurfaceForDiamond(diamond, DEPLOYMENTS) ?? positionNftSurface({ diamond });
}
