/**
 * GoPlus token-security screening (#1036).
 *
 * THREAT MODEL — the accept side is primary: a malicious actor
 * creates their offer straight against the Diamond (no website), so
 * the creator-side paste-branch check never ran for it. The offer
 * then sits on the shared book looking normal, collateralized by (or
 * lending) a honeypot / pump-and-dump token that CANNOT be sold or
 * transferred no matter what the deal terms say — the one harm class
 * the illiquid-consent warnings can't catch, because those only say
 * "unpriced", not "booby-trapped".
 *
 * The public GoPlus endpoint needs no API key (per-IP rate limits),
 * which fits alpha02's no-operator-secret posture. Verdicts are
 * cached per (chainId, address) in the shared react-query cache with
 * a long stale time — contract maliciousness doesn't flip minute to
 * minute, and the book badges must not hammer the rate limit.
 *
 * POSTURE:
 *  - curated tokens: never screened (pre-vetted list, no extra call);
 *  - pasted / offer-carried non-curated tokens: fail-CLOSED at the
 *    gates — "couldn't check" is a blocking state with its own copy,
 *    never silently treated as clean;
 *  - hard signals (honeypot / can't-sell-all / blacklist+transfer-
 *    pausable) → BLOCK; soft signals (heavy tax, owner-mint,
 *    owner-balance-mutation) → loud warning the user must explicitly
 *    accept via the existing consent mechanics.
 */
import { useQuery } from '@tanstack/react-query';
import { getCanonicalAssetsForChain } from '@vaipakam/lib';

const GOPLUS_ORIGIN = 'https://api.gopluslabs.io';
const TIMEOUT_MS = 6_000;

/** Chains GoPlus's token_security endpoint covers that we deploy to.
 *  A chain missing here yields verdict 'unsupported' — surfaced as a
 *  soft notice, NOT a block: on test networks every faucet mock would
 *  otherwise be unbuyable (GoPlus doesn't index testnets). */
const GOPLUS_CHAINS = new Set([1, 56, 8453, 42161, 10, 137]);

export type TokenSecurityVerdict =
  | { kind: 'clean' }
  | { kind: 'warn'; reasons: string[] }
  | { kind: 'block'; reasons: string[] }
  | { kind: 'unsupported' } // chain not covered by GoPlus (testnets)
  | { kind: 'unknown' }; // API unreachable / no data — fail-closed at gates

interface GoPlusTokenRow {
  is_honeypot?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_mintable?: string;
  owner_change_balance?: string;
  is_blacklisted?: string;
  transfer_pausable?: string;
  is_open_source?: string;
}

const flag = (v: string | undefined) => v === '1';
const taxPct = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : 0;
};

/** Map a GoPlus row onto the block/warn/clean verdict. Exported for
 *  tests and for the eligibility gate's copy. */
export function classifyTokenSecurity(row: GoPlusTokenRow): TokenSecurityVerdict {
  const block: string[] = [];
  const warn: string[] = [];
  if (flag(row.is_honeypot)) block.push('flagged as a honeypot — buyers cannot sell it');
  if (flag(row.cannot_sell_all)) block.push('holders are prevented from selling their full balance');
  if (flag(row.cannot_buy)) block.push('buying is restricted by the contract');
  if (flag(row.is_blacklisted) && flag(row.transfer_pausable)) {
    block.push('the owner can blacklist holders AND pause all transfers');
  } else {
    if (flag(row.is_blacklisted)) warn.push('the owner can blacklist individual holders');
    if (flag(row.transfer_pausable)) warn.push('the owner can pause all transfers');
  }
  const bt = taxPct(row.buy_tax);
  const st = taxPct(row.sell_tax);
  if (st >= 50) block.push(`a ${st.toFixed(0)}% sell tax`);
  else if (st >= 10) warn.push(`a ${st.toFixed(0)}% sell tax`);
  if (bt >= 50) block.push(`a ${bt.toFixed(0)}% buy tax`);
  else if (bt >= 10) warn.push(`a ${bt.toFixed(0)}% buy tax`);
  if (flag(row.is_mintable) && flag(row.owner_change_balance)) {
    warn.push('the owner can mint AND rewrite holder balances');
  } else if (flag(row.owner_change_balance)) {
    warn.push('the owner can rewrite holder balances');
  }
  if (block.length) return { kind: 'block', reasons: [...block, ...warn] };
  if (warn.length) return { kind: 'warn', reasons: warn };
  return { kind: 'clean' };
}

/** One-shot fetch — exported so submit-time gates can re-verify
 *  without a hook. Returns 'unknown' on any failure (fail-closed at
 *  the caller's gate). */
export async function fetchTokenSecurity(
  chainId: number,
  address: string,
): Promise<TokenSecurityVerdict> {
  if (!GOPLUS_CHAINS.has(chainId)) return { kind: 'unsupported' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(
      `${GOPLUS_ORIGIN}/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return { kind: 'unknown' };
    const body = (await res.json()) as {
      result?: Record<string, GoPlusTokenRow>;
    };
    const row = body.result?.[address.toLowerCase()];
    if (!row) return { kind: 'unknown' }; // not indexed — can't clear it
    return classifyTokenSecurity(row);
  } catch {
    return { kind: 'unknown' };
  }
}

/** Is this address on the chain's curated list (pre-vetted — never
 *  screened, never blocked)? */
export function isCuratedAsset(chainId: number, address: string): boolean {
  try {
    return getCanonicalAssetsForChain(chainId)
      .map((a: string) => a.toLowerCase())
      .includes(address.toLowerCase());
  } catch {
    return false;
  }
}

/** Reactive verdict for a NON-curated token. Disabled (returns
 *  undefined data) for curated/empty addresses. Long stale time:
 *  maliciousness signals don't flip minute-to-minute and the shared
 *  cache keeps the book badges inside the public rate limit. */
export function useTokenSecurity(
  chainId: number | undefined,
  address: string | undefined,
) {
  const enabled = Boolean(
    chainId &&
      address &&
      /^0x[a-fA-F0-9]{40}$/.test(address) &&
      !isCuratedAsset(chainId, address),
  );
  return useQuery({
    queryKey: ['tokenSecurity', chainId, address?.toLowerCase()],
    enabled,
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
    queryFn: () => fetchTokenSecurity(chainId!, address!),
  });
}
