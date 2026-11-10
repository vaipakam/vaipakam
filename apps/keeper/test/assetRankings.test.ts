/**
 * The asset rankings pass (#3446): two public market-data sources, the top
 * 500 by rank per mainnet chain, keyed by contract address, written to the
 * shared tables the app's trust tiers read.
 *
 * The HTTP layer is a fake keyed by URL, so every test states exactly what the
 * sources answered. The database is the shared schema.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_RANKED,
  RANKING_CHAINS,
  ROWS_PER_INSERT,
  buildChainRows,
  cleanText,
  describeOutcomes,
  fetchJson,
  isPairDue,
  normalizeAddress,
  parseCgMarkets,
  parseCpContracts,
  parseCpTickers,
  runAssetRankings,
  runAssetRankingsWith,
  type FetchFn,
} from '../src/assetRankings';
import { D1_MAX_BOUND_PARAMETERS } from '@vaipakam/lib/d1Binds';
import { createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';
import type { Env } from '../src/env';

const CG = 'https://api.coingecko.com/api/v3';
const CP = 'https://api.coinpaprika.com/v1';

/** A day boundary plus some hours, in seconds. */
const DAY = 86_400;
const T0 = 20_400 * DAY + 3_600;

const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

/** 500 ranked coins, `coin-1` … `coin-500`. */
function cgPages(count = 500): unknown[] {
  const all = Array.from({ length: count }, (_, i) => ({
    id: `coin-${i + 1}`,
    symbol: `c${i + 1}`,
    name: `Coin ${i + 1}`,
    market_cap_rank: i + 1,
  }));
  return [all.slice(0, 250), all.slice(250, 500)];
}

/** `cg` coin list: coin-N on every chain at address N (+ a chain offset). */
function cgList(): unknown[] {
  return Array.from({ length: 600 }, (_, i) => {
    const n = i + 1;
    const platforms: Record<string, string> = {};
    for (const [k, c] of RANKING_CHAINS.entries()) platforms[c.cg] = addr(n + k * 10_000);
    return { id: `coin-${n}`, symbol: `c${n}`, name: `Coin ${n}`, platforms };
  });
}

function cpTickers(count = 500): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p-coin-${i + 1}`,
    name: `P Coin ${i + 1}`,
    symbol: `P${i + 1}`,
    rank: i + 1,
  }));
}

function cpContracts(chainIndex: number): unknown[] {
  return Array.from({ length: 500 }, (_, i) => ({
    address: addr(i + 1 + chainIndex * 10_000),
    type: 'ERC20',
    id: `p-coin-${i + 1}`,
    active: true,
  }));
}

/** The answers of both sources, by URL; a missing URL answers 404. */
function sources(overrides: Record<string, unknown | Response> = {}): Record<string, unknown | Response> {
  const pages = cgPages();
  const out: Record<string, unknown | Response> = {
    [`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`]: pages[0],
    [`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2`]: pages[1],
    [`${CG}/coins/list?include_platform=true`]: cgList(),
    [`${CP}/tickers`]: cpTickers(),
  };
  for (const [k, c] of RANKING_CHAINS.entries()) out[`${CP}/contracts/${c.cp}`] = cpContracts(k);
  return { ...out, ...overrides };
}

function fakeFetch(answers: Record<string, unknown | Response>): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const a = answers[url];
    if (a === undefined) return new Response('not found', { status: 404 });
    if (a instanceof Response) return a;
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, calls };
}

function deps(h: SqliteD1, fetchFn: FetchFn, nowSec = T0, deadlineMs = Date.now() + 600_000) {
  return { db: h.d1 as unknown as D1Database, fetchFn, deadlineMs, nowSec: () => nowSec };
}

function rows(h: SqliteD1, source: string, chainId: number) {
  return h.db
    .prepare('SELECT address, rank, name, symbol, fetched_at FROM asset_ranking WHERE source = ? AND chain_id = ? ORDER BY rank, address')
    .all(source, chainId) as { address: string; rank: number; name: string; symbol: string; fetched_at: number }[];
}

function run(h: SqliteD1, source: string, chainId: number) {
  return h.db
    .prepare('SELECT fetched_at, row_count, ok, detail FROM asset_ranking_run WHERE source = ? AND chain_id = ?')
    .get(source, chainId) as { fetched_at: number; row_count: number; ok: number; detail: string | null } | undefined;
}

describe('a good run', () => {
  it('writes the top 500 of both sources on every chain, by address, and records each run', async () => {
    const h = createSharedD1();
    const { fetchFn } = fakeFetch(sources());
    const out = await runAssetRankingsWith(deps(h, fetchFn));
    expect(out).toHaveLength(RANKING_CHAINS.length * 2);
    expect(out.every((o) => o.result === 'written')).toBe(true);
    for (const [k, c] of RANKING_CHAINS.entries()) {
      for (const source of ['cg', 'cp']) {
        const r = rows(h, source, c.chainId);
        expect(r).toHaveLength(500);
        expect(r[0].address).toBe(addr(1 + k * 10_000));
        expect(r[0].rank).toBe(1);
        expect(r[499].rank).toBe(500);
        expect(new Set(r.map((x) => x.fetched_at))).toEqual(new Set([T0]));
        expect(run(h, source, c.chainId)).toEqual({ fetched_at: T0, row_count: 500, ok: 1, detail: null });
      }
    }
    // coin-501..600 are in the coin list but not ranked: never written.
    expect(rows(h, 'cg', 1).some((x) => x.address === addr(501))).toBe(false);
  });

  it('replaces the previous list rather than adding to it', async () => {
    const h = createSharedD1();
    await runAssetRankingsWith(deps(h, fakeFetch(sources()).fetchFn));
    // Next day, coin-1 is gone from cp's Ethereum contracts.
    const next = sources({ [`${CP}/contracts/eth-ethereum`]: cpContracts(0).slice(1) });
    await runAssetRankingsWith(deps(h, fakeFetch(next).fetchFn, T0 + DAY));
    const r = rows(h, 'cp', 1);
    expect(r).toHaveLength(499);
    expect(r.some((x) => x.address === addr(1))).toBe(false);
    expect(run(h, 'cp', 1)?.row_count).toBe(499);
  });

  it('stays under the bound-parameter cap in every insert', () => {
    expect(ROWS_PER_INSERT * 7).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });
});

describe('the once-a-day rule', () => {
  it('fetches nothing again the same UTC day after a good run, and fetches again the next day', async () => {
    const h = createSharedD1();
    await runAssetRankingsWith(deps(h, fakeFetch(sources()).fetchFn));
    const later = fakeFetch(sources());
    const out = await runAssetRankingsWith(deps(h, later.fetchFn, T0 + 3 * 3600));
    expect(out).toEqual([]);
    expect(later.calls).toEqual([]);
    expect(describeOutcomes(out)).toBe('nothing due');
    const nextDay = fakeFetch(sources());
    await runAssetRankingsWith(deps(h, nextDay.fetchFn, T0 + DAY));
    expect(nextDay.calls.length).toBeGreaterThan(0);
  });

  it('retries a failed pair the next hour without refetching the pairs that succeeded', async () => {
    const h = createSharedD1();
    const first = sources({ [`${CP}/contracts/base-base`]: new Response('busy', { status: 503 }) });
    await runAssetRankingsWith(deps(h, fakeFetch(first).fetchFn));
    expect(run(h, 'cp', 8453)?.ok).toBe(0);
    const retry = fakeFetch(sources());
    const out = await runAssetRankingsWith(deps(h, retry.fetchFn, T0 + 3600));
    expect(out).toEqual([{ source: 'cp', chainId: 8453, result: 'written', rows: 500 }]);
    expect(retry.calls).toEqual([`${CP}/tickers`, `${CP}/contracts/base-base`]);
  });

  it('isPairDue reads the UTC day of the last good run', () => {
    expect(isPairDue(undefined, T0)).toBe(true);
    expect(isPairDue({ source: 'cg', chainId: 1, fetchedAt: T0, ok: 0 }, T0)).toBe(true);
    expect(isPairDue({ source: 'cg', chainId: 1, fetchedAt: T0, ok: 1 }, T0 + 3600)).toBe(false);
    expect(isPairDue({ source: 'cg', chainId: 1, fetchedAt: T0 - 2 * 3600, ok: 1 }, T0)).toBe(true); // yesterday 23:00
  });
});

describe('a failed run keeps the last good list', () => {
  it('a source that does not answer records ok=0 on each due chain and leaves its rows', async () => {
    const h = createSharedD1();
    await runAssetRankingsWith(deps(h, fakeFetch(sources()).fetchFn));
    const down = sources({ [`${CG}/coins/list?include_platform=true`]: new Response('rate limited', { status: 429 }) });
    await runAssetRankingsWith(deps(h, fakeFetch(down).fetchFn, T0 + DAY));
    for (const c of RANKING_CHAINS) {
      expect(run(h, 'cg', c.chainId)).toEqual({ fetched_at: T0 + DAY, row_count: 500, ok: 0, detail: 'HTTP 429 (/api/v3/coins/list)' });
      expect(rows(h, 'cg', c.chainId)).toHaveLength(500);
      expect(rows(h, 'cg', c.chainId)[0].fetched_at).toBe(T0); // the last good date
      expect(run(h, 'cp', c.chainId)?.ok).toBe(1);
    }
  });

  it('refuses a short ranked list instead of replacing a full one with it', async () => {
    const h = createSharedD1();
    await runAssetRankingsWith(deps(h, fakeFetch(sources()).fetchFn));
    const short = sources({ [`${CP}/tickers`]: cpTickers(MIN_RANKED - 1) });
    await runAssetRankingsWith(deps(h, fakeFetch(short).fetchFn, T0 + DAY));
    expect(run(h, 'cp', 1)?.ok).toBe(0);
    expect(run(h, 'cp', 1)?.detail).toContain('ranked list short');
    expect(rows(h, 'cp', 1)).toHaveLength(500);
  });

  it('refuses a chain that maps to no address, naming the platform, and never writes it empty', async () => {
    const h = createSharedD1();
    const { fetchFn } = fakeFetch(sources({ [`${CP}/contracts/op-optimism`]: [] }));
    await runAssetRankingsWith(deps(h, fetchFn));
    expect(run(h, 'cp', 10)).toEqual({
      fetched_at: T0,
      row_count: 0,
      ok: 0,
      detail: 'cp mapped no ranked coin to an address on Optimism (platform op-optimism)',
    });
    expect(rows(h, 'cp', 10)).toHaveLength(0);
    expect(run(h, 'cp', 1)?.ok).toBe(1); // the other chains still written
  });

  it('a response that is not the expected shape fails the source, not the pass', async () => {
    const h = createSharedD1();
    const { fetchFn } = fakeFetch(sources({ [`${CP}/tickers`]: { error: 'no' } }));
    const out = await runAssetRankingsWith(deps(h, fetchFn));
    expect(out.filter((o) => o.source === 'cp').every((o) => o.result === 'failed')).toBe(true);
    expect(run(h, 'cp', 1)?.detail).toBe('cp tickers is not a list');
    expect(out.filter((o) => o.source === 'cg').every((o) => o.result === 'written')).toBe(true);
  });

  it('records nothing for pairs it ran out of time for, so they stay due', async () => {
    const h = createSharedD1();
    const { fetchFn, calls } = fakeFetch(sources());
    const out = await runAssetRankingsWith(deps(h, fetchFn, T0, Date.now() - 1));
    expect(calls).toEqual([]);
    expect(out.every((o) => o.result === 'out of time')).toBe(true);
    expect(run(h, 'cg', 1)).toBeUndefined();
  });
});

describe('mapping ranks to addresses', () => {
  const eth = RANKING_CHAINS[0];
  const ranked = [
    { id: 'a', rank: 3, name: 'A', symbol: 'A' },
    { id: 'b', rank: 7, name: 'B', symbol: 'B' },
  ];

  it('an address claimed by two ranked coins keeps the lower rank, whatever the order', () => {
    const one = buildChainRows('cp', eth, ranked, [['b', addr(9)], ['a', addr(9)]]);
    const two = buildChainRows('cp', eth, ranked, [['a', addr(9)], ['b', addr(9)]]);
    expect(one).toEqual([{ address: addr(9), rank: 3, name: 'A', symbol: 'A' }]);
    expect(two).toEqual(one);
  });

  it('a coin with two addresses on one chain gets a row for each', () => {
    const r = buildChainRows('cp', eth, ranked, [['a', addr(1)], ['a', addr(2)]]);
    expect(r.map((x) => x.address)).toEqual([addr(1), addr(2)]);
  });

  it('cp skips inactive contracts and unranked coins', () => {
    const pairs = parseCpContracts(
      [
        { address: addr(1), id: 'a', active: false },
        { address: addr(2), id: 'zzz', active: true },
        { address: addr(3), id: 'b', active: true },
      ],
      new Set(['a', 'b']),
    );
    expect(pairs).toEqual([['b', addr(3)]]);
  });

  it('a coin repeated across two pages keeps its lower rank', () => {
    const r = parseCgMarkets([
      [{ id: 'x', name: 'X', symbol: 'x', market_cap_rank: 250 }],
      [{ id: 'x', name: 'X', symbol: 'x', market_cap_rank: 251 }, { id: 'y', name: 'Y', symbol: 'y', market_cap_rank: null }],
    ]);
    expect(r).toEqual([{ id: 'x', rank: 250, name: 'X', symbol: 'x' }]);
  });

  it('only ranks 1 to 500 count', () => {
    const r = parseCpTickers([
      { id: 'a', rank: 0 },
      { id: 'b', rank: 501 },
      { id: 'c', rank: 2.5 },
      { id: 'd', rank: 500 },
    ]);
    expect(r.map((c) => c.id)).toEqual(['d']);
  });

  it('stores addresses lowercase and never stores the zero address or a malformed one', () => {
    expect(normalizeAddress('0xABCDEF0000000000000000000000000000000001')).toBe('0xabcdef0000000000000000000000000000000001');
    expect(normalizeAddress(`0x${'0'.repeat(40)}`)).toBeNull();
    expect(normalizeAddress('0x1234')).toBeNull();
    expect(normalizeAddress('')).toBeNull();
    expect(normalizeAddress(42)).toBeNull();
  });
});

describe('names and symbols', () => {
  it('drops control, bidirectional and zero-width characters and caps the length', () => {
    expect(cleanText('  Tether‮ USD\u0000 ', 100)).toBe('Tether USD');
    expect(cleanText('U​SDC', 100)).toBe('USDC');
    expect(cleanText('x'.repeat(200), 100)).toHaveLength(100);
    expect(cleanText(undefined, 10)).toBe('');
  });
});

describe('the HTTP read', () => {
  it('refuses a body over the cap', async () => {
    const big = new Response('[]', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
    await expect(fetchJson(async () => big, 'https://x', Date.now() + 10_000)).rejects.toThrow(/exceeds/);
  });

  it('names the status of a refused request', async () => {
    await expect(
      fetchJson(async () => new Response('no', { status: 500 }), 'https://x', Date.now() + 10_000),
    ).rejects.toThrow('HTTP 500 (/)');
  });
});

describe('arming', () => {
  it('does nothing while ASSET_RANKINGS_ENABLED is unset', async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      const env = { KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}` } as unknown as Env;
      await runAssetRankings(env, { scheduledTimeMs: undefined, deadlineMs: Date.now() + 1000 });
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual(['[keeper] assetRankings skipped: ASSET_RANKINGS_ENABLED unset']);
  });
});
