/**
 * NFT-13 — the standard an asset's contract claims, read once per network
 * and address and shared by every surface that asks (the pair picker's line
 * and the page that decides which flow the asset takes).
 */
import { useChainRead } from '../reads/chainRead';
import { readStandard } from './nft';

type Hex = `0x${string}`;

export function useAssetStandard(asset: Hex | null) {
  return useChainRead(['assetStandard', asset?.toLowerCase() ?? null], (c) => readStandard(c, asset!), { immutable: true, enabled: asset !== null });
}
