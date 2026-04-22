import { Contract } from 'ethers';
import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

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

export async function fetchTokenMeta(
  address: string,
  diamond: { runner?: { provider?: unknown } | null } | null,
): Promise<TokenMeta> {
  seedMemoryFromStorage();
  const key = address.toLowerCase();
  if (key === ZERO_ADDRESS) return nativeMeta();
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const provider = diamond?.runner?.provider;
  const fallback: TokenMeta = { address: key, symbol: '', decimals: 18 };
  if (!provider) return fallback;

  const task = (async () => {
    try {
      const token = new Contract(address, ERC20_ABI, provider as never);
      const [symbol, decimals] = await Promise.all([
        token.symbol().catch(() => ''),
        token.decimals().then((d: bigint | number) => Number(d)).catch(() => 18),
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
  const diamond = useDiamondRead();
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
    fetchTokenMeta(address, diamond).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [address, diamond]);

  return meta;
}
