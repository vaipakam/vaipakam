import { useEffect, useState } from 'react';
import {
  fetchTopTokensForChain,
  fetchStablecoinsForChain,
  verifyContract,
  type CoinGeckoToken,
  type CoinGeckoVerification,
} from '../lib/coingecko';

// Stable empty reference so consumers putting the returned `tokens` in a deps
// array don't see identity churn on every render of the no-chain path.
const EMPTY_TOKENS: CoinGeckoToken[] = [];

export function useTopTokens(chainId: number | null | undefined, limit = 50) {
  const [fetched, setFetched] = useState<CoinGeckoToken[]>(EMPTY_TOKENS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // No-chain path is handled by the derivation below (returning empty tokens,
    // loading=false, error=null). Skipping the effect avoids the
    // setState-in-effect lint and its cascading-render concern.
    if (!chainId) return;
    let cancelled = false;
    // loading=true marker is the standard data-fetching shape. The
    // set-state-in-effect rule would have us use React Query or similar here;
    // suppressing for this self-contained fetch hook.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchTopTokensForChain(chainId, limit)
      .then((t) => {
        if (!cancelled) setFetched(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, limit]);

  return chainId
    ? { tokens: fetched, loading, error }
    : { tokens: EMPTY_TOKENS, loading: false, error: null };
}

export function useStablecoins(chainId: number | null | undefined) {
  const [fetched, setFetched] = useState<CoinGeckoToken[]>(EMPTY_TOKENS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!chainId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchStablecoinsForChain(chainId)
      .then((t) => {
        if (!cancelled) setFetched(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return chainId
    ? { tokens: fetched, loading, error }
    : { tokens: EMPTY_TOKENS, loading: false, error: null };
}

/**
 * Runs `verifyContract` for the given address (debounced 400ms). Returns null
 * until a verification result is available. Empty/invalid addresses reset to null.
 */
export function useVerifyContract(
  chainId: number | null | undefined,
  address: string | null | undefined,
) {
  const [result, setResult] = useState<CoinGeckoVerification | null>(null);
  const [loading, setLoading] = useState(false);

  const addressValid =
    !!address && /^0x[a-fA-F0-9]{40}$/.test(address);
  const inputsReady = !!chainId && addressValid;

  useEffect(() => {
    if (!inputsReady) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const t = setTimeout(() => {
      verifyContract(chainId!, address!)
        .then((r) => {
          if (!cancelled) setResult(r);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chainId, address, inputsReady]);

  return inputsReady
    ? { result, loading }
    : { result: null, loading: false };
}
