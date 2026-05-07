/**
 * Maps EVM chainIds to CoinGecko "asset platform" IDs used in their API
 * (e.g. `/coins/list?include_platform=true` returns `platforms[platformId] = contractAddress`).
 *
 * Testnets are intentionally unmapped — CoinGecko does not index testnet tokens.
 * Callers should treat `null` as "token discovery unavailable; manual address entry only".
 */
export const COINGECKO_PLATFORMS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  8453: 'base',
  42161: 'arbitrum-one',
};

export function platformForChain(chainId: number | null | undefined): string | null {
  if (!chainId) return null;
  return COINGECKO_PLATFORMS[chainId] ?? null;
}

export function isTestnet(chainId: number | null | undefined): boolean {
  if (!chainId) return false;
  return !(chainId in COINGECKO_PLATFORMS);
}
