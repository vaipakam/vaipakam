import { platformForChain } from './chainPlatforms.js';

/**
 * Lightweight CoinGecko client with localStorage caching.
 * Shared by apps that need curated token discovery (defi, alpha01).
 */

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export interface CoinGeckoToken {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  marketCapRank: number | null;
  contractAddress: string;
}

export interface CoinGeckoVerification {
  known: boolean;
  inTop200: boolean;
  marketCapRank: number | null;
  isStablecoin: boolean;
  id: string | null;
  symbol: string | null;
  name: string | null;
}

interface CachedValue<T> {
  v: T;
  exp: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cacheKey(ns: string, chainId: number, extra = ''): string {
  return `vaipakam:cg:${ns}:${chainId}${extra ? ':' + extra : ''}`;
}

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedValue<T>;
    if (parsed.exp < Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, value: T, ttl: number): void {
  try {
    const entry: CachedValue<T> = { v: value, exp: Date.now() + ttl };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // ignore quota errors
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`CoinGecko ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as T;
}

interface CGMarket {
  id: string;
  symbol: string;
  name: string;
  image: string;
  market_cap_rank: number | null;
}

interface CGCoinFull {
  id: string;
  symbol: string;
  name: string;
  image: { small: string; thumb: string };
  market_cap_rank: number | null;
  platforms: Record<string, string>;
  categories: string[];
}

interface CGListEntry {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string>;
}

let platformListInflight: Promise<CGListEntry[]> | null = null;

async function fetchPlatformList(): Promise<CGListEntry[]> {
  const key = 'vaipakam:cg:platform-list:v1';
  const cached = readCache<CGListEntry[]>(key);
  if (cached) return cached;
  if (platformListInflight) return platformListInflight;

  platformListInflight = (async () => {
    try {
      const list = await fetchJson<CGListEntry[]>(
        `${COINGECKO_BASE}/coins/list?include_platform=true`,
      );
      writeCache(key, list, DAY);
      return list;
    } finally {
      platformListInflight = null;
    }
  })();
  return platformListInflight;
}

export async function fetchTopTokensForChain(
  chainId: number,
  limit: number,
): Promise<CoinGeckoToken[]> {
  const platform = platformForChain(chainId);
  if (!platform) return [];

  const key = cacheKey('top', chainId, String(limit));
  const cached = readCache<CoinGeckoToken[]>(key);
  if (cached) return cached;

  const [markets, platformList] = await Promise.all([
    fetchJson<CGMarket[]>(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`,
    ),
    fetchPlatformList(),
  ]);

  const byId = new Map(platformList.map((e) => [e.id, e.platforms]));
  const result: CoinGeckoToken[] = [];
  for (const m of markets) {
    const platforms = byId.get(m.id);
    if (!platforms) continue;
    const contract = platforms[platform];
    if (!contract) continue;
    result.push({
      id: m.id,
      symbol: m.symbol.toUpperCase(),
      name: m.name,
      image: m.image,
      marketCapRank: m.market_cap_rank,
      contractAddress: contract.toLowerCase(),
    });
    if (result.length >= limit) break;
  }

  writeCache(key, result, HOUR);
  return result;
}

export async function fetchStablecoinsForChain(chainId: number): Promise<CoinGeckoToken[]> {
  const platform = platformForChain(chainId);
  if (!platform) return [];

  const key = cacheKey('stables', chainId);
  const cached = readCache<CoinGeckoToken[]>(key);
  if (cached) return cached;

  const [stableMarkets, platformList] = await Promise.all([
    fetchJson<CGMarket[]>(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=100&page=1&sparkline=false`,
    ),
    fetchPlatformList(),
  ]);

  const byId = new Map(platformList.map((e) => [e.id, e.platforms]));
  const result: CoinGeckoToken[] = [];
  for (const m of stableMarkets) {
    const platforms = byId.get(m.id);
    if (!platforms) continue;
    const contract = platforms[platform];
    if (!contract) continue;
    result.push({
      id: m.id,
      symbol: m.symbol.toUpperCase(),
      name: m.name,
      image: m.image,
      marketCapRank: m.market_cap_rank,
      contractAddress: contract.toLowerCase(),
    });
  }

  writeCache(key, result, DAY);
  return result;
}

export async function verifyContract(
  chainId: number,
  address: string,
): Promise<CoinGeckoVerification> {
  const platform = platformForChain(chainId);
  const normalized = address.toLowerCase();
  const fallback: CoinGeckoVerification = {
    known: false,
    inTop200: false,
    marketCapRank: null,
    isStablecoin: false,
    id: null,
    symbol: null,
    name: null,
  };
  if (!platform) return fallback;

  const key = cacheKey('verify', chainId, normalized);
  const cached = readCache<CoinGeckoVerification>(key);
  if (cached) return cached;

  try {
    const coin = await fetchJson<CGCoinFull>(
      `${COINGECKO_BASE}/coins/${platform}/contract/${normalized}`,
    );
    const rank = coin.market_cap_rank ?? null;
    const result: CoinGeckoVerification = {
      known: true,
      inTop200: rank !== null && rank <= 200,
      marketCapRank: rank,
      isStablecoin: (coin.categories ?? [])
        .map((c) => c.toLowerCase())
        .includes('stablecoins'),
      id: coin.id,
      symbol: coin.symbol?.toUpperCase() ?? null,
      name: coin.name ?? null,
    };
    writeCache(key, result, HOUR);
    return result;
  } catch {
    writeCache(key, fallback, HOUR);
    return fallback;
  }
}