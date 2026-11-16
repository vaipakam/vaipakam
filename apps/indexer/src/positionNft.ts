/**
 * #3205 — the indexer's ONE door to the position NFTs. Every chain's
 * deployment record names its standalone PositionNFT: owners are read there,
 * `Transfer` logs are emitted there, and a closed position's token is
 * RETIRED by the Diamond's `PositionRetired`, never burned. The rule lives in
 * `@vaipakam/lib/positionNft`, which refuses a record without `positionNFT`
 * (#3321).
 */
import type { Address } from 'viem';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import {
  POSITION_NFT_INDEXED_EVENTS,
  positionNftSurfaceForDiamond,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';

/** The live holder of a position token (`'gone'` once retired); the one
 *  holder read every indexer path uses. */
export { readPositionHolder } from '@vaipakam/lib/positionNftReads';
export type { PositionNftSurface };

/** The surface of the chain whose Diamond is `diamond`. Throws when no
 *  deployment record names the Diamond, or when its record names no
 *  PositionNFT: the indexer never reads the Diamond as the NFT. */
export function positionNftForDiamond(diamond: Address): PositionNftSurface {
  const s = positionNftSurfaceForDiamond(diamond, DEPLOYMENTS);
  if (!s) throw new Error(`no deployment record names Diamond ${diamond}; its PositionNFT is unknown`);
  return s;
}

/** The addresses whose logs the scan reads: the Diamond and its PositionNFT
 *  (the ERC-721 events). */
export function scannedAddresses(diamond: Address): Address[] {
  return [diamond, positionNftForDiamond(diamond).nft as Address];
}

/** The PositionNFT's ERC-721 events, decoded outside the generated Diamond
 *  ABI: the shared list the Activity participant rule also reads
 *  (`@vaipakam/lib/positionNft`). */
export const POSITION_NFT_EVENTS = POSITION_NFT_INDEXED_EVENTS;
