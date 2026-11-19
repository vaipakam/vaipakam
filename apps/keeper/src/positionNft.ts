/**
 * #3205 — the keeper's ONE door to the position NFTs: every chain's
 * deployment record names its standalone PositionNFT. The rule lives in
 * `@vaipakam/lib/positionNft`, which refuses a record without `positionNFT`
 * (#3321).
 */
import type { Address } from 'viem';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import { positionNftSurfaceForDiamond, type PositionNftSurface } from '@vaipakam/lib/positionNft';

export {
  POSITION_ERC721_ABI,
  positionHolderCalls,
  positionHolderFrom,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';

/** The surface of the chain whose Diamond is `diamond`. Throws when no
 *  deployment record names the Diamond, or when its record names no
 *  PositionNFT: the keeper never reads the Diamond as the NFT. */
export function positionNftForDiamond(diamond: Address): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}; its PositionNFT is unknown`);
  return s;
}
