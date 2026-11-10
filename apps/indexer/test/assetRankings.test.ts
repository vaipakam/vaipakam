/**
 * `GET /assets/rankings` (#3446): one chain's stored market-cap rankings,
 * read against migration 0087's real DDL.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { handleAssetRankings, parseTokenChainId, type AssetRankings } from '../src/assetRankings';

const DDL = [readFileSync(new URL('../migrations/0087_asset_rankings.sql', import.meta.url), 'utf8')];
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

function seeded() {
  const h = createSqliteD1(DDL);
  const rank = h.db.prepare('INSERT INTO asset_ranking (chain_id, address, source, rank, name, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  rank.run(1, USDC, 'cg', 7, 'USDC', 'USDC', 1_000);
  rank.run(1, USDC, 'cp', 6, 'USD Coin', 'USDC', 900);
  rank.run(1, WETH, 'cg', 20, 'WETH', 'WETH', 1_000);
  rank.run(8453, USDC, 'cg', 1, 'Other chain', 'X', 1_000);
  const run = h.db.prepare('INSERT INTO asset_ranking_run (source, chain_id, fetched_at, row_count, ok, detail) VALUES (?, ?, ?, ?, ?, ?)');
  run.run('cg', 1, 1_000, 2, 1, null);
  run.run('cp', 1, 2_000, 0, 0, 'HTTP 429');
  return h;
}

const get = (db: unknown, qs: string) => handleAssetRankings(new Request(`https://idx.test/assets/rankings${qs}`), db as never);

describe('GET /assets/rankings', () => {
  it('lists each token once, keeping every source’s rank, name and symbol apart', async () => {
    const res = await get(seeded().d1, '?chainId=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as AssetRankings;
    expect(body.chainId).toBe(1);
    expect(body.assets).toEqual([
      {
        address: USDC,
        ranks: { cg: { rank: 7, name: 'USDC', symbol: 'USDC' }, cp: { rank: 6, name: 'USD Coin', symbol: 'USDC' } },
      },
      { address: WETH, ranks: { cg: { rank: 20, name: 'WETH', symbol: 'WETH' } } },
    ]);
  });

  it('states a failed refresh beside the older list it left in place', async () => {
    const body = (await (await get(seeded().d1, '?chainId=1')).json()) as AssetRankings;
    expect(body.sources.cg).toEqual({ listFetchedAt: 1_000, lastRun: { fetchedAt: 1_000, ok: true, rowCount: 2, detail: null } });
    expect(body.sources.cp).toEqual({ listFetchedAt: 900, lastRun: { fetchedAt: 2_000, ok: false, rowCount: 0, detail: 'HTTP 429' } });
  });

  it('answers a chain with nothing stored with nulls, not a guess', async () => {
    const body = (await (await get(seeded().d1, '?chainId=10')).json()) as AssetRankings;
    expect(body.assets).toEqual([]);
    expect(body.sources).toEqual({ cg: { listFetchedAt: null, lastRun: null }, cp: { listFetchedAt: null, lastRun: null } });
  });

  it('requires the token chain id', async () => {
    for (const qs of ['', '?chainId=', '?chainId=0', '?chainId=-1', '?chainId=1.5', '?chainId=0x1', '?chainId=01']) {
      expect((await get(seeded().d1, qs)).status).toBe(400);
    }
    expect(parseTokenChainId('42161')).toBe(42161);
    expect(parseTokenChainId('99999999999999999')).toBeNull();
  });

  it('answers 503, never an empty list, before the migration is applied', async () => {
    const res = await get(createSqliteD1([]).d1, '?chainId=1');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('refuses a row the migration does not admit', () => {
    const h = createSqliteD1(DDL);
    const ins = h.db.prepare('INSERT INTO asset_ranking (chain_id, address, source, rank, name, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    expect(() => ins.run(1, USDC.toUpperCase().replace('0X', '0x'), 'cg', 1, 'n', 's', 1)).toThrow();
    expect(() => ins.run(1, USDC, 'xx', 1, 'n', 's', 1)).toThrow();
    expect(() => ins.run(1, USDC, 'cg', 501, 'n', 's', 1)).toThrow();
  });
});
