import { useEffect, useState } from 'react';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';

const STALE_MS = 60_000;

/**
 * Effective view of the internal-liquidation match path's governance
 * surface (B.2 / PR3 of the internal-match work). Reads
 * `ConfigFacet.getInternalMatchConfigBundle` and returns the
 * `(enabled, priorityWindowBps, incentivePerLegBps)` tuple resolved
 * to effective values (override OR library default).
 *
 * Kept as a separate hook (rather than folded into
 * `useProtocolConfig`) so the main bundle's shape stays stable —
 * older deploys without the internal-match surface still load.
 * Silent-fallback on read failure: caller treats `null` config as
 * "feature dormant" (matches the kill-switch-off behavior), so the
 * match-related UI surfaces stay hidden.
 */
export interface InternalMatchConfig {
  /** Master kill-switch — when `false` the matching entry point reverts
   *  `InternalMatchDisabled`, the match-eligible view returns empty,
   *  and the external-path priority-window gate inside
   *  `triggerLiquidation` short-circuits (external stays callable
   *  everywhere). */
  enabled: boolean;
  /** Global LTV window (BPS) above each loan's per-tier liquidation
   *  threshold where external `triggerLiquidation` is blocked so
   *  internal matchers get a clean priority slot. Default 200 BPS
   *  (2% LTV); admin-tunable in [0, 500] via
   *  `ConfigFacet.setInternalMatchConfig`. */
  externalLiquidationPriorityWindowBps: number;
  /** Per-leg bot incentive (BPS) — withheld from each matched leg's
   *  transferred collateral and routed to the calling matcher. Default
   *  100 BPS (1% per leg); admin-tunable in [0, 300]. */
  internalMatchIncentivePerLegBps: number;
  fetchedAt: number;
}

interface CacheEntry {
  data: InternalMatchConfig;
  at: number;
  key: string;
}
let cached: CacheEntry | null = null;

type ConfigTuple = [boolean, bigint, bigint];

export function useInternalMatchConfig() {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}`;

  const [config, setConfig] = useState<InternalMatchConfig | null>(() =>
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
          getInternalMatchConfigBundle: () => Promise<ConfigTuple>;
        };
        const [enabled, window, incentive] = await d.getInternalMatchConfigBundle();
        if (cancelled) return;
        const data: InternalMatchConfig = {
          enabled: Boolean(enabled),
          externalLiquidationPriorityWindowBps: Number(window),
          internalMatchIncentivePerLegBps: Number(incentive),
          fetchedAt: Date.now(),
        };
        cached = { data, at: Date.now(), key: cacheKey };
        setConfig(data);
        setLoading(false);
      } catch {
        // Silent fallback — feature treated as disabled when the
        // read fails (older deploy, RPC blip, selector not cut).
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
