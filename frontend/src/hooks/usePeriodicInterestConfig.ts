import { useEffect, useState } from 'react';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';

const STALE_MS = 60_000;

/**
 * Effective view of the T-034 Periodic Interest Payment config surface.
 * Resolves every knob to its effective value (override or library
 * default) via `ConfigFacet.getPeriodicInterestConfig`. Kept as a
 * separate hook (rather than folded into `useProtocolConfig`) so the
 * existing bundle's shape stays stable — old deploys without the T-034
 * surface still load correctly.
 */
export interface PeriodicInterestConfig {
  /** USD-Sweep / B1 — bytes32 lowercase ASCII symbol of the active
   *  numeraire (e.g. `0x0000…0000usd`, `0x0000…0000eur`). Empty
   *  bytes32 = post-deploy default ("usd"). */
  numeraireSymbol: `0x${string}`;
  /** Effective principal threshold for finer cadences, in numeraire-
   *  units (1e18-scaled). */
  minPrincipalForFinerCadence1e18: bigint;
  /** Effective shared pre-notify lead time, in days. */
  preNotifyDays: number;
  /** Master kill-switch — when `false` the entire feature is dormant. */
  periodicInterestEnabled: boolean;
  /** Independent kill-switch for the cross-numeraire batched setter. */
  numeraireSwapEnabled: boolean;
  fetchedAt: number;
}

interface CacheEntry {
  data: PeriodicInterestConfig;
  at: number;
  key: string;
}
let cached: CacheEntry | null = null;

type ConfigTuple = [`0x${string}`, bigint, number, boolean, boolean];

export function usePeriodicInterestConfig() {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}`;

  const [config, setConfig] = useState<PeriodicInterestConfig | null>(() =>
    cached && cached.key === cacheKey ? cached.data : null,
  );
  const [loading, setLoading] = useState(!(cached && cached.key === cacheKey));

  useEffect(() => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setConfig(cached.data);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const d = diamond as unknown as {
          getPeriodicInterestConfig: () => Promise<ConfigTuple>;
        };
        const [
          numeraireSymbol,
          threshold,
          preNotifyDays,
          periodicEnabled,
          numeraireSwapEnabled,
        ] = await d.getPeriodicInterestConfig();
        if (cancelled) return;
        const data: PeriodicInterestConfig = {
          numeraireSymbol,
          minPrincipalForFinerCadence1e18: BigInt(threshold),
          preNotifyDays: Number(preNotifyDays),
          periodicInterestEnabled: Boolean(periodicEnabled),
          numeraireSwapEnabled: Boolean(numeraireSwapEnabled),
          fetchedAt: Date.now(),
        };
        cached = { data, at: Date.now(), key: cacheKey };
        setConfig(data);
        setLoading(false);
      } catch {
        // Silent fallback: feature treated as disabled when the read
        // fails (older deploy, RPC blip). Caller treats `null` config
        // as "feature dormant" — the cadence dropdown stays hidden,
        // matching the kill-switch-off behavior.
        if (cancelled) return;
        setConfig(null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamond, cacheKey]);

  return { config, loading };
}
