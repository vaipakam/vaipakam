import { useEffect, useState } from 'react';
import {
  fetchStablecoinsForChain,
  fetchTopTokensForChain,
  verifyContract,
  type CoinGeckoToken,
  type CoinGeckoVerification,
} from '@vaipakam/lib/coingecko';

const EMPTY: CoinGeckoToken[] = [];

export function useTopTokens(chainId: number | null | undefined, limit = 30) {
  const [tokens, setTokens] = useState<CoinGeckoToken[]>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!chainId) return;
    let cancelled = false;
    setTokens(EMPTY);
    setLoading(true);
    void fetchTopTokensForChain(chainId, limit)
      .then((t) => {
        if (!cancelled) setTokens(t);
      })
      .catch(() => {
        if (!cancelled) setTokens(EMPTY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, limit]);

  return { tokens: chainId ? tokens : EMPTY, loading: Boolean(chainId) && loading };
}

export function useStablecoins(chainId: number | null | undefined) {
  const [tokens, setTokens] = useState<CoinGeckoToken[]>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!chainId) return;
    let cancelled = false;
    setTokens(EMPTY);
    setLoading(true);
    void fetchStablecoinsForChain(chainId)
      .then((t) => {
        if (!cancelled) setTokens(t);
      })
      .catch(() => {
        if (!cancelled) setTokens(EMPTY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return { tokens: chainId ? tokens : EMPTY, loading: Boolean(chainId) && loading };
}

export function useVerifyContract(
  chainId: number | null | undefined,
  address: string | null | undefined,
) {
  const [result, setResult] = useState<CoinGeckoVerification | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!chainId || !address) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void verifyContract(chainId, address)
      .then((v) => {
        if (!cancelled) setResult(v);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, address]);

  return { result, loading };
}