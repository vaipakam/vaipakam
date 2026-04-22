import { useCallback, useEffect, useState } from 'react';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STALE_MS = 30_000;
const TOKEN_DECIMALS_SCALE = 1e18;

export interface VPFITokenSnapshot {
  /** Registered VPFI token proxy address on this chain, or zero if unset. */
  token: string;
  /** True when the Diamond has been bound to a token via `setVPFIToken`. */
  registered: boolean;
  /** Total VPFI in circulation on this chain, normalized to a JS number. */
  totalSupply: number;
  /** Hard cap (230M) expressed as a JS number. */
  cap: number;
  /** Remaining mintable headroom (`cap - totalSupply`). */
  capHeadroom: number;
  /** Share of cap minted so far, 0..1. */
  circulatingShare: number;
  /** Single authorized minter address, or zero when unregistered. */
  minter: string;
  fetchedAt: number;
}

let cached: { data: VPFITokenSnapshot; at: number; key: string } | null = null;

/**
 * Transparency view over the VPFI token — token address, circulating supply,
 * cap headroom, and minter — read through VPFITokenFacet. No wallet is
 * required; everything is public chain state.
 *
 * Values are cached module-scoped for {@link STALE_MS} so multiple cards on
 * the same dashboard share a single round-trip.
 */
export function useVPFIToken() {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? '').toLowerCase()}`;

  const [snapshot, setSnapshot] = useState<VPFITokenSnapshot | null>(() =>
    cached && cached.key === cacheKey ? cached.data : null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setSnapshot(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useVPFIToken', step: 'readViews' });
    try {
      const d = diamond as unknown as {
        getVPFIToken: () => Promise<string>;
        getVPFITotalSupply: () => Promise<bigint>;
        getVPFICap: () => Promise<bigint>;
        getVPFICapHeadroom: () => Promise<bigint>;
        getVPFIMinter: () => Promise<string>;
      };
      const [token, totalSupplyRaw, capRaw, headroomRaw, minter] = await Promise.all([
        d.getVPFIToken(),
        d.getVPFITotalSupply(),
        d.getVPFICap(),
        d.getVPFICapHeadroom(),
        d.getVPFIMinter(),
      ]);

      const cap = Number(capRaw) / TOKEN_DECIMALS_SCALE;
      const totalSupply = Number(totalSupplyRaw) / TOKEN_DECIMALS_SCALE;
      const capHeadroom = Number(headroomRaw) / TOKEN_DECIMALS_SCALE;
      const circulatingShare = cap === 0 ? 0 : totalSupply / cap;

      const next: VPFITokenSnapshot = {
        token,
        registered: token !== ZERO_ADDRESS,
        totalSupply,
        cap,
        capHeadroom,
        circulatingShare,
        minter,
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now(), key: cacheKey };
      setSnapshot(next);
      step.success({
        note: next.registered
          ? `VPFI registered, ${totalSupply.toFixed(0)} / ${cap.toFixed(0)}`
          : 'VPFI not yet registered',
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  /**
   * Read the VPFI balance of an arbitrary account. Not part of the cached
   * snapshot because the relevant account changes per caller (wallet vs
   * treasury vs arbitrary address).
   */
  const getBalanceOf = useCallback(
    async (account: string): Promise<number> => {
      const d = diamond as unknown as {
        getVPFIBalanceOf: (a: string) => Promise<bigint>;
      };
      const raw = await d.getVPFIBalanceOf(account);
      return Number(raw) / TOKEN_DECIMALS_SCALE;
    },
    [diamond],
  );

  return { snapshot, loading, error, reload, getBalanceOf };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearVPFITokenCache() {
  cached = null;
}
