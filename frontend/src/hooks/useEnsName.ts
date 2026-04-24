import { useEffect, useState } from 'react';
import { createPublicClient, http, isAddress, type Address } from 'viem';
import { mainnet, base } from 'viem/chains';

/**
 * ENS / Basenames reverse resolution — Phase 8a.1.
 *
 * Resolves `0x…` → `nick.eth` / `nick.base.eth` for display purposes.
 * Tries mainnet ENS first (the largest namespace); falls back to Base's
 * basename resolver (`*.base.eth` reverse records). Caches results in
 * `sessionStorage` so we don't spam JSON-RPC on every render.
 *
 * The returned name is **display-only**. Never use it as an identifier —
 * always transact against the raw address.
 */

const CACHE_KEY_PREFIX = 'vaipakam:ens:';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — names change rarely

type CacheEntry = {
  name: string | null;
  ts: number;
};

// Module-level in-memory cache avoids a second resolve inside the same
// render pass when multiple components ask for the same address.
const memCache = new Map<string, CacheEntry>();

// One shared mainnet client; ENS gateway calls (CCIP-Read) flow through
// viem's default transport. Basename resolution piggy-backs on the same
// mainnet client because Coinbase's `*.base.eth` records register on
// mainnet ENS and the resolver delegates on-chain to an L2 gateway.
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

// Fallback: Base public client for any `*.base` native-basename record
// (Coinbase also issues some basenames as direct Base L2 names without
// a mainnet shadow). The standard ENS path covers the dominant case;
// this client is lazily used only when the mainnet path returns null.
const baseClient = createPublicClient({
  chain: base,
  transport: http(),
});

function loadCache(addr: string): CacheEntry | null {
  const key = addr.toLowerCase();
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;

  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.ts >= CACHE_TTL_MS) return null;
    memCache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

function storeCache(addr: string, name: string | null) {
  const entry: CacheEntry = { name, ts: Date.now() };
  const key = addr.toLowerCase();
  memCache.set(key, entry);
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + key, JSON.stringify(entry));
  } catch {
    // quota / privacy mode — ignore, in-memory cache still works
  }
}

export interface UseEnsNameResult {
  /** Resolved ENS / basename, or null if no record or not yet resolved. */
  name: string | null;
  /** True while an unresolved address is being fetched from mainnet / Base. */
  loading: boolean;
}

/**
 * Reverse-resolve a raw address to an ENS or basename. Returns
 * `{ name: null, loading: false }` for zero address, invalid input, or
 * when no reverse record exists.
 *
 * Never throws. Never retries on its own — if the remote lookup fails,
 * the cached null survives until its TTL expires. Callers should fall
 * back to `shortenAddr` when `name` is null.
 */
export function useEnsName(addr: string | null | undefined): UseEnsNameResult {
  const [state, setState] = useState<UseEnsNameResult>(() => {
    if (!addr || !isAddress(addr)) return { name: null, loading: false };
    const cached = loadCache(addr);
    if (cached) return { name: cached.name, loading: false };
    return { name: null, loading: true };
  });

  useEffect(() => {
    if (!addr || !isAddress(addr)) {
      setState({ name: null, loading: false });
      return;
    }
    const cached = loadCache(addr);
    if (cached) {
      setState({ name: cached.name, loading: false });
      return;
    }
    let cancelled = false;
    setState({ name: null, loading: true });

    (async () => {
      let name: string | null = null;
      try {
        name = (await mainnetClient.getEnsName({ address: addr as Address })) ?? null;
      } catch {
        name = null;
      }
      if (!name) {
        try {
          // viem's `getEnsName` on the Base client walks Base's primary-
          // name registry — covers Coinbase-issued Basenames that don't
          // have a mainnet shadow record.
          name = (await baseClient.getEnsName({ address: addr as Address })) ?? null;
        } catch {
          // ignore
        }
      }
      if (cancelled) return;
      storeCache(addr, name);
      setState({ name, loading: false });
    })();

    return () => {
      cancelled = true;
    };
  }, [addr]);

  return state;
}
