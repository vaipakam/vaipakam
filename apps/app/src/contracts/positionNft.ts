/**
 * #3205 — the app's ONE door to the position NFTs. Every read or write of a
 * position token's owner, approvals, transfers or open route goes through
 * here, so a chain's mode (standalone `PositionNFT`, or the pre-#3205 Diamond
 * on a chain not yet freshly deployed) is decided once, from its deployment
 * record. The rules and the frozen legacy fragment live in
 * `@vaipakam/lib/positionNft`.
 *
 * TODO(#3321 positionNft-legacy-removal): the LEGACY (Diamond) branch is
 * deleted at the all-waves fresh deploy, with every `mode === 'legacy'` test
 * in the app.
 */
import { DEPLOYMENTS, getDeployment } from '@vaipakam/contracts/deployments';
import { PositionNFTABI } from '@vaipakam/contracts/abis';
import type { Abi } from 'viem';
import {
  positionNftSurface,
  positionNftSurfaceForDiamond,
  routeBlocksTransfer,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';
import { useActiveChain } from '../chain/useActiveChain';
import { readPositionHolder, readPositionOwner, readPositionRoute } from '@vaipakam/lib/positionNftReads';

export * from '@vaipakam/lib/positionNftReads';

/** The generated PositionNFT ABI: the holder lock and the ERC-721 surface
 *  (standalone mode only). */
export const POSITION_NFT_ABI = PositionNFTABI as Abi;

/** The surface for `chainId`, or null when the bundle has no record. */
export function positionNftFor(chainId: number | undefined): PositionNftSurface | null {
  const d = getDeployment(chainId);
  return d?.diamond ? positionNftSurface(d) : null;
}

/** The surface of the chain whose Diamond is `diamond`. Throws when no
 *  record names it: a caller must not guess the mode. */
export function positionNftForDiamond(diamond: string): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}; its position-NFT mode is unknown`);
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

/** Whether an open protocol route blocks a position NFT's transfer on the
 *  chain the app is reading (legacy mode), or a transfer instead stops the
 *  route completing (standalone). Picks which copy a surface shows. */
export function useRouteBlocksTransfer(): boolean {
  const { readChain } = useActiveChain();
  // A chain object without a surface (a test double) reads as legacy.
  return readChain.positionNft ? routeBlocksTransfer(readChain.positionNft) : true;
}
