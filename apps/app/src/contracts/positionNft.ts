/**
 * #3205 — the app's ONE door to the position NFTs. Every read or write of a
 * position token's owner, approvals, transfers or open route goes through
 * here: owners, approvals and transfers at the chain's `PositionNFT`, the
 * open route and retirement at its Diamond, both named by the deployment
 * record. The rules live in `@vaipakam/lib/positionNft`, which refuses a
 * record without `positionNFT` (#3321).
 */
import { DEPLOYMENTS, getDeployment } from '@vaipakam/contracts/deployments';
import { PositionNFTABI } from '@vaipakam/contracts/abis';
import type { Abi } from 'viem';
import {
  positionNftSurface,
  positionNftSurfaceForDiamond,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';
import { readPositionHolder, readPositionOwner, readPositionRoute } from '@vaipakam/lib/positionNftReads';

export * from '@vaipakam/lib/positionNftReads';

/** The generated PositionNFT ABI: the holder lock and the ERC-721 surface. */
export const POSITION_NFT_ABI = PositionNFTABI as Abi;

/** The surface for `chainId`, or null when the bundle has no record. */
export function positionNftFor(chainId: number | undefined): PositionNftSurface | null {
  const d = getDeployment(chainId);
  return d?.diamond ? positionNftSurface(d) : null;
}

/** The surface of the chain whose Diamond is `diamond`. Throws when no
 *  record names it, or when its record names no PositionNFT. */
export function positionNftForDiamond(diamond: string): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}; its PositionNFT is unknown`);
  return s;
}

type Client = Parameters<typeof readPositionRoute>[0];
type TokenId = bigint | number | string;

/** {@link readPositionRoute} for the chain whose Diamond is `diamond`. */
export async function readPositionRouteOn(client: Client, diamond: string, tokenId: TokenId, blockNumber?: bigint) {
  return readPositionRoute(client, positionNftForDiamond(diamond), tokenId, blockNumber);
}

/** {@link readPositionOwner} for the chain whose Diamond is `diamond`. */
export async function readPositionOwnerOn(client: Client, diamond: string, tokenId: TokenId, blockNumber?: bigint) {
  return readPositionOwner(client, positionNftForDiamond(diamond), tokenId, blockNumber);
}

/** {@link readPositionHolder} for the chain whose Diamond is `diamond`. */
export async function readPositionHolderOn(client: Client, diamond: string, tokenId: TokenId, blockNumber?: bigint) {
  return readPositionHolder(client, positionNftForDiamond(diamond), tokenId, blockNumber);
}
