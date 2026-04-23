import { useEffect, useState } from 'react';
import { getContract, type Address, type PublicClient } from 'viem';
import { useDiamondPublicClient } from '../contracts/useDiamond';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// viem-typed ERC20 ABI — just the two reads this module consumes.
const ERC20_ABI = [
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const STORAGE_KEY = 'vaipakam:tokenMeta:v1';
const memoryCache = new Map<string, TokenMeta>();
const inflight = new Map<string, Promise<TokenMeta>>();

function loadPersisted(): Record<string, TokenMeta> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, TokenMeta>) : {};
  } catch {
    return {};
  }
}

function persist(meta: TokenMeta) {
  try {
    const all = loadPersisted();
    all[meta.address] = meta;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore quota / private-mode
  }
}

function seedMemoryFromStorage() {
  if (memoryCache.size > 0) return;
  const persisted = loadPersisted();
  for (const [k, v] of Object.entries(persisted)) memoryCache.set(k, v);
}

function nativeMeta(): TokenMeta {
  return { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 };
}

/**
 * Resolve the ERC-20 `symbol()` + `decimals()` for `address`, caching the
 * pair in memory + localStorage. Uses the caller-supplied viem PublicClient
 * (typically from `useDiamondPublicClient()`) so every read targets the
 * same upstream RPC the rest of the app already hit through wagmi.
 */
export async function fetchTokenMeta(
  address: string,
  publicClient: PublicClient | null,
): Promise<TokenMeta> {
  seedMemoryFromStorage();
  const key = address.toLowerCase();
  if (key === ZERO_ADDRESS) return nativeMeta();
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const fallback: TokenMeta = { address: key, symbol: '', decimals: 18 };
  if (!publicClient) return fallback;

  const task = (async () => {
    try {
      const token = getContract({
        address: address as Address,
        abi: ERC20_ABI,
        client: publicClient,
      });
      const [symbol, decimals] = await Promise.all([
        token.read.symbol().catch(() => ''),
        token.read
          .decimals()
          .then((d) => Number(d))
          .catch(() => 18),
      ]);
      const meta: TokenMeta = { address: key, symbol, decimals };
      memoryCache.set(key, meta);
      if (symbol) persist(meta);
      return meta;
    } catch {
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * Resolve ERC-20 symbol + decimals for `address`. Cached in-memory and in
 * localStorage so switching pages doesn't re-query the RPC.
 */
export function useTokenMeta(address: string | null | undefined): TokenMeta | null {
  const publicClient = useDiamondPublicClient();
  const [meta, setMeta] = useState<TokenMeta | null>(() => {
    if (!address) return null;
    seedMemoryFromStorage();
    const key = address.toLowerCase();
    if (key === ZERO_ADDRESS) return nativeMeta();
    return memoryCache.get(key) ?? null;
  });

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchTokenMeta(address, publicClient).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient]);

  return meta;
}
