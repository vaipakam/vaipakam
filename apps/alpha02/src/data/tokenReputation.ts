/**
 * CoinGecko reputation soft-signal (#1036 — the fallback layer of the
 * token screen, ported from defi's `lib/coingecko.ts` verifyContract).
 *
 * Reputation and security are complementary: GoPlus answers "is this
 * contract booby-trapped", CoinGecko answers "does the wider market
 * know this token at all". A pasted address that passes the security
 * screen can still be a nobody-token whose name imitates a major —
 * the market-listing lookup is the cheap tell, and a positive match
 * (name + rank) doubles as identity confirmation against paste
 * mistakes.
 *
 * Strictly a SOFT signal: it never blocks, never gates, and renders
 * nothing on chains CoinGecko has no platform for (testnets — where
 * every faucet mock would otherwise warn "unlisted", teaching users
 * to ignore the line). The free-tier rate limit is respected via a
 * long react-query stale time; listings don't churn minute to minute.
 */
import { useQuery } from '@tanstack/react-query';
import { platformForChain } from '@vaipakam/lib/chainPlatforms';
import { copy } from '../content/copy';
import { needsSecurityCheck } from './tokenSecurity';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const TIMEOUT_MS = 6_000;

export type TokenReputation =
  | { kind: 'listed'; name: string; symbol: string | null; rank: number | null }
  | { kind: 'unlisted' } // CoinGecko positively doesn't index it
  | { kind: 'unknown' } // lookup failed — say nothing (soft layer)
  | { kind: 'unsupported' }; // chain has no CoinGecko platform (testnets)

interface CGCoin {
  name?: string;
  symbol?: string;
  market_cap_rank?: number | null;
}

export async function fetchTokenReputation(
  chainId: number,
  address: string,
): Promise<TokenReputation> {
  const platform = platformForChain(chainId);
  if (!platform) return { kind: 'unsupported' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(
      `${COINGECKO_BASE}/coins/${platform}/contract/${address.toLowerCase()}`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    );
    clearTimeout(t);
    // 404 is a POSITIVE answer ("not indexed"); anything else that
    // isn't ok (429 rate limit, 5xx) proves nothing — stay silent.
    if (res.status === 404) return { kind: 'unlisted' };
    if (!res.ok) return { kind: 'unknown' };
    const coin = (await res.json()) as CGCoin;
    if (!coin.name) return { kind: 'unknown' };
    return {
      kind: 'listed',
      name: coin.name,
      symbol: coin.symbol ? coin.symbol.toUpperCase() : null,
      rank: coin.market_cap_rank ?? null,
    };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Reputation for a pasted NON-curated token. Shares the picker's
 *  own "needs checking" definition so curated assets never spend a
 *  lookup. */
export function useTokenReputation(
  chainId: number | undefined,
  address: string | undefined,
) {
  const platformKnown = Boolean(chainId && platformForChain(chainId));
  return useQuery({
    queryKey: ['tokenReputation', chainId, address?.toLowerCase()],
    enabled: platformKnown && needsSecurityCheck(chainId, address),
    staleTime: 60 * 60_000,
    gcTime: 2 * 60 * 60_000,
    retry: false,
    queryFn: () => fetchTokenReputation(chainId!, address!),
  });
}

/** The soft notice line, or null when there is nothing worth saying
 *  ('unknown' stays silent — a failed lookup proves nothing, and the
 *  security screen already covers the hard cases). */
export function reputationNotice(
  rep: TokenReputation | undefined,
): string | null {
  if (rep === undefined) return null;
  switch (rep.kind) {
    case 'listed':
      return rep.rank !== null && rep.rank <= 200
        ? copy.tokenSecurity.reputationListedTop(rep.name, rep.symbol ? ` (${rep.symbol})` : '', rep.rank)
        : copy.tokenSecurity.reputationListedDeep(rep.name, rep.symbol ? ` (${rep.symbol})` : '');
    case 'unlisted':
      return copy.tokenSecurity.reputationUnlisted;
    default:
      return null;
  }
}
