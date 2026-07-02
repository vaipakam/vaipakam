import { getCanonicalAssetsForChain } from '@vaipakam/lib/canonicalAssets';
import type { CoinGeckoToken } from '@vaipakam/lib/coingecko';

const CANONICAL_LABELS: Record<string, { symbol: string; name: string }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', name: 'Wrapped Ether' },
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', name: 'USD Coin (testnet)' },
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': { symbol: 'WETH', name: 'Wrapped Ether (Sepolia)' },
  '0x94a9d9ac8a22534e3facaf4e7f2e2cf85d5e4c8': { symbol: 'USDC', name: 'USD Coin (Sepolia)' },
  '0x980b62da83eff3d4576c647993b0c1d7faf17c73': { symbol: 'WETH', name: 'Wrapped Ether (Arb Sepolia)' },
  '0xae13d989dac2f0debff460ac112a837c89baa7cd': { symbol: 'WBNB', name: 'Wrapped BNB (testnet)' },
};

function canonicalEntry(chainId: number, address: string): CoinGeckoToken {
  const key = address.toLowerCase();
  const label = CANONICAL_LABELS[key];
  return {
    id: `canonical-${chainId}-${key}`,
    symbol: label?.symbol ?? 'TOKEN',
    name: label?.name ?? 'Canonical asset',
    image: null,
    marketCapRank: null,
    contractAddress: key,
  };
}

/** Merge CoinGecko list with per-chain canonicals; canonicals win on address collision. */
export function mergeCuratedTokens(
  chainId: number,
  remote: CoinGeckoToken[],
): CoinGeckoToken[] {
  const byAddr = new Map<string, CoinGeckoToken>();
  for (const t of remote) byAddr.set(t.contractAddress.toLowerCase(), t);
  for (const addr of getCanonicalAssetsForChain(chainId)) {
    const key = addr.toLowerCase();
    if (!byAddr.has(key)) byAddr.set(key, canonicalEntry(chainId, key));
  }
  return [...byAddr.values()].sort((a, b) => {
    const ra = a.marketCapRank ?? 9999;
    const rb = b.marketCapRank ?? 9999;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
}

