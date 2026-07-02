import { useEffect, useState } from 'react';
import { getContract, type Address, type PublicClient } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

const STORAGE_KEY = 'vaipakam:alpha01:tokenMeta:v2';
const memoryCache = new Map<string, TokenMeta>();
const inflight = new Map<string, Promise<TokenMeta>>();
let storageSeeded = false;

function metaCacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

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
    all[metaCacheKey(meta.chainId, meta.address)] = meta;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore quota / private-mode
  }
}

function seedMemoryFromStorage() {
  if (storageSeeded) return;
  const persisted = loadPersisted();
  for (const [k, v] of Object.entries(persisted)) memoryCache.set(k, v);
  storageSeeded = true;
}

/** Vitest helper — reload memory cache from localStorage between cases. */
export function resetTokenMetaCacheForTests(): void {
  memoryCache.clear();
  inflight.clear();
  storageSeeded = false;
  seedMemoryFromStorage();
}

function nativeMeta(chainId: number): TokenMeta {
  return { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18, chainId };
}

export async function fetchTokenMeta(
  address: string,
  publicClient: PublicClient | null,
  chainId: number,
): Promise<TokenMeta> {
  seedMemoryFromStorage();
  const key = metaCacheKey(chainId, address);
  if (address.toLowerCase() === ZERO_ADDRESS) return nativeMeta(chainId);
  const cached = memoryCache.get(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const normalized = address.toLowerCase();
  const fallback: TokenMeta = { address: normalized, symbol: '', decimals: 0, chainId };
  if (!publicClient) return fallback;

  const task = (async () => {
    try {
      const token = getContract({
        address: address as Address,
        abi: ERC20_ABI,
        client: publicClient,
      });
      const [symbolResult, decimalsResult] = await Promise.allSettled([
        token.read.symbol(),
        token.read.decimals().then((d) => Number(d)),
      ]);
      const symbol = symbolResult.status === 'fulfilled' ? symbolResult.value : '';
      const decimals =
        decimalsResult.status === 'fulfilled' && Number.isFinite(decimalsResult.value)
          ? decimalsResult.value
          : null;
      if (symbol && decimals != null) {
        const meta: TokenMeta = { address: normalized, symbol, decimals, chainId };
        memoryCache.set(key, meta);
        persist(meta);
        return meta;
      }
      // Do not treat a failed decimals() read as 18 — leave unresolved (not cached).
      return { address: normalized, symbol: symbol || '', decimals: decimals ?? 0, chainId };
    } catch {
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

function metaForAddress(
  meta: TokenMeta | null | undefined,
  address: string,
  chainId: number,
): TokenMeta | null {
  const key = address.toLowerCase();
  if (meta?.address?.toLowerCase() === key && meta.chainId === chainId && meta.symbol) return meta;
  const peeked = peekTokenMeta(address, chainId);
  if (peeked?.address?.toLowerCase() === key && peeked.chainId === chainId && peeked.symbol) return peeked;
  return null;
}

/** True when on-chain metadata has been fetched for this exact address on this chain. */
export function hasResolvedTokenDecimals(
  _meta: TokenMeta | null | undefined,
  address: string,
  chainId: number,
): boolean {
  const key = address.toLowerCase();
  if (key === ZERO_ADDRESS) return true;
  const cacheKey = metaCacheKey(chainId, key);
  const cached = memoryCache.get(cacheKey);
  if (!cached || cached.address.toLowerCase() !== key || cached.chainId !== chainId || !cached.symbol) {
    return false;
  }
  return Number.isFinite(cached.decimals) && cached.decimals > 0;
}

export function requireTokenDecimals(
  meta: TokenMeta | null | undefined,
  address: string,
  label: string,
  chainId: number,
): number {
  const resolved = metaForAddress(meta, address, chainId);
  if (!resolved || !Number.isFinite(resolved.decimals)) {
    throw new Error(`${label} token metadata is still loading`);
  }
  return resolved.decimals;
}

export function peekTokenMeta(
  address: string | null | undefined,
  chainId: number | null | undefined,
): TokenMeta | null {
  if (!address || chainId == null) return null;
  seedMemoryFromStorage();
  const key = address.toLowerCase();
  if (key === ZERO_ADDRESS) return nativeMeta(chainId);
  return memoryCache.get(metaCacheKey(chainId, key)) ?? null;
}

export function useTokenMeta(address: string | null | undefined): TokenMeta | null {
  const chain = useReadChain();
  const publicClient = useDiamondPublicClient();
  const chainId = chain.chainId;
  const [meta, setMeta] = useState<TokenMeta | null>(() => {
    if (!address) return null;
    seedMemoryFromStorage();
    const key = address.toLowerCase();
    if (key === ZERO_ADDRESS) return nativeMeta(chainId);
    return memoryCache.get(metaCacheKey(chainId, key)) ?? null;
  });

  useEffect(() => {
    if (!address) {
      setMeta(null);
      return;
    }
    const key = address.toLowerCase();
    seedMemoryFromStorage();
    setMeta(key === ZERO_ADDRESS ? nativeMeta(chainId) : memoryCache.get(metaCacheKey(chainId, key)) ?? null);

    let cancelled = false;
    void fetchTokenMeta(address, publicClient, chainId).then((m) => {
      if (!cancelled && m.address.toLowerCase() === key && m.chainId === chainId) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [address, chainId, publicClient]);

  return meta;
}