/**
 * #3205 — the indexer's ONE door to the position NFTs. A chain's mode comes
 * from its deployment record: the standalone PositionNFT when the record
 * lists `positionNFT` (owners read there, `Transfer` logs emitted there, a
 * closed position's token RETIRED by the Diamond's `PositionRetired`), else
 * the pre-#3205 Diamond (owners and `Transfer` on the Diamond, a closed
 * position's token burned). The rule lives in `@vaipakam/lib/positionNft`.
 *
 * TODO(#3321 positionNft-legacy-removal): the legacy (Diamond) branch is
 * deleted at the all-waves fresh deploy.
 */
import type { Address } from 'viem';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import {
  POSITION_ERC721_ABI,
  POSITION_NFT_INDEXED_EVENTS,
  positionNftSurface,
  positionNftSurfaceForDiamond,
  type PositionNftSurface,
} from '@vaipakam/lib/positionNft';

/** The live holder of a position token (`'gone'` once retired or burned);
 *  the one holder read every indexer path uses. */
export { readPositionHolder } from '@vaipakam/lib/positionNftReads';
export type { PositionNftSurface };

/** The surface of the chain whose Diamond is `diamond`. A Diamond no record
 *  names is read as legacy: the Diamond itself, the only contract the
 *  indexer was given. */
export function positionNftForDiamond(diamond: Address): PositionNftSurface {
  return positionNftSurfaceForDiamond(diamond, DEPLOYMENTS) ?? positionNftSurface({ diamond });
}

/** The addresses whose logs the scan reads: the Diamond, plus the
 *  PositionNFT in standalone mode (its `Transfer` events). */
export function scannedAddresses(diamond: Address): Address[] {
  const s = positionNftForDiamond(diamond);
  return s.mode === 'standalone' ? [diamond, s.nft as Address] : [diamond];
}

/** The ERC-721 `Transfer` event, identical on both contracts. The generated
 *  Diamond ABI lost it with #3205, so the scan adds it here. */
export const POSITION_TRANSFER_EVENT = POSITION_ERC721_ABI.find(
  (e) => e.type === 'event' && e.name === 'Transfer',
)!;

/** Every position-NFT event decoded outside the generated Diamond ABI (the
 *  legacy fragment's and the PositionNFT's ERC-721 ones): the shared list the
 *  Activity participant rule also reads (`@vaipakam/lib/positionNft`). */
export const LEGACY_POSITION_EVENTS = POSITION_NFT_INDEXED_EVENTS;
