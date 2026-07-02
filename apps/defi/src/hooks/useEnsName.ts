import { useEffect, useState } from 'react';
import { useChainId } from 'wagmi';
import { createPublicClient, http, isAddress, type Address } from 'viem';
import { mainnet, base } from 'viem/chains';
import { CHAIN_REGISTRY } from '../contracts/config';

/** Local/dev chains where ENS resolution is meaningless and would only fire
 *  noisy cross-origin probes at public mainnet RPCs (F-20260630-005). A user
 *  connected to Anvil is offline-by-design; skip the lookup entirely so the
 *  console isn't flooded with `eth.llamarpc.com` CORS rejections that mask
 *  real wallet/chain failures. ENS still resolves normally on every real
 *  network (mainnet + testnets) — an address's mainnet ENS name is valid
 *  regardless of which chain the user is transacting on. */
const ENS_SKIP_CHAIN_IDS = new Set<number>([31337]);

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
 *
 * RPC selection: we explicitly route through the operator-configured
 * mainnet / Base RPCs from `CHAIN_REGISTRY` (env-driven via
 * `VITE_ETHEREUM_RPC_URL` / `VITE_BASE_RPC_URL`). Calling viem's
 * `http()` with no URL falls back to viem's chain definition default,
 * which for mainnet is `https://eth.merkle.io` — that endpoint does
 * NOT allow browser-origin CORS, so every ENS lookup from a vaipakam
 * page fired a 403 preflight rejection visible in the console. Using
 * the registry URLs (default `https://eth.llamarpc.com` and
 * `https://mainnet.base.org`, both CORS-permissive) silences the
 * spam, and operators who set their own URL get the same routing.
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

const ETHEREUM_RPC_URL = CHAIN_REGISTRY[1]?.rpcUrl;
const BASE_RPC_URL = CHAIN_REGISTRY[8453]?.rpcUrl;

// Mainnet client: ENS gateway calls (CCIP-Read) flow through the
// configured mainnet RPC. Basename resolution piggy-backs on the same
// mainnet client because Coinbase's `*.base.eth` records register on
// mainnet ENS and the resolver delegates on-chain to an L2 gateway.
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(ETHEREUM_RPC_URL),
});

// Fallback: Base public client for any `*.base` native-basename record
// (Coinbase also issues some basenames as direct Base L2 names without
// a mainnet shadow). The standard ENS path covers the dominant case;
// this client is lazily used only when the mainnet path returns null.
const baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
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
  // Active chain — on local Anvil we short-circuit before any external RPC
  // probe (see {ENS_SKIP_CHAIN_IDS}). `useChainId` returns the connected
  // wallet's chain, or the config default when disconnected.
  const chainId = useChainId();
  const skipEns = ENS_SKIP_CHAIN_IDS.has(chainId);

  const [state, setState] = useState<UseEnsNameResult>(() => {
    if (skipEns || !addr || !isAddress(addr)) return { name: null, loading: false };
    const cached = loadCache(addr);
    if (cached) return { name: cached.name, loading: false };
    return { name: null, loading: true };
  });

  useEffect(() => {
    if (skipEns || !addr || !isAddress(addr)) {
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
  }, [addr, skipEns]);

  return state;
}
