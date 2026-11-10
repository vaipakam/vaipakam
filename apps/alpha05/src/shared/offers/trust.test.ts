import { describe, expect, it } from 'vitest';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { classifyAsset, listAge, oldestList, rankTier, readAssetRankings, searchRanked, type AssetRankings } from './trust';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const D = '0x' + 'd'.repeat(40);

function client(body: unknown): IndexerClient {
  return { origin: 'https://index.test', getJson: async <T>() => body as T };
}

const STORED = { listFetchedAt: 1_000, lastRun: { fetchedAt: 1_000, ok: true, rowCount: 3, detail: null } };

function body(assets: unknown[], sources: Record<string, unknown> = { cg: STORED, cp: STORED }) {
  return { chainId: 8453, sources, assets };
}

async function rankings(assets: unknown[], sources?: Record<string, unknown>): Promise<AssetRankings> {
  return readAssetRankings(client(body(assets, sources)), 8453);
}

const rank = (rank: number, symbol: string, name = symbol) => ({ rank, name, symbol });

function classify(r: AssetRankings, address: string, extra: Partial<Parameters<typeof classifyAsset>[0]> = {}) {
  return classifyAsset({ address, rankings: r, testnet: false, testToken: false, priced: true, symbol: null, name: null, ...extra });
}

describe('readAssetRankings', () => {
  it('reads each list’s view of each address, by lowercase address', async () => {
    const r = await rankings([{ address: A.toUpperCase().replace('0X', '0x'), ranks: { cg: rank(3, 'WETH'), cp: rank(4, 'WETH') } }]);
    expect(r.byAddress.get(A)).toEqual({ cg: rank(3, 'WETH'), cp: rank(4, 'WETH') });
    expect(r.sources.cg.listFetchedAt).toBe(1_000);
  });

  it('refuses an answer for another network, or one it cannot read', async () => {
    await expect(readAssetRankings(client({ ...body([]), chainId: 1 }), 8453)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(rankings([{ address: 'nope', ranks: {} }])).rejects.toThrow('readable address');
    await expect(rankings([{ address: A, ranks: { cg: { rank: 0, name: 'x', symbol: 'x' } } }])).rejects.toThrow('readable rank');
    await expect(rankings([], { cg: { listFetchedAt: 'yesterday', lastRun: null }, cp: STORED })).rejects.toThrow('readable date');
  });
});

describe('classifyAsset', () => {
  it('ranks by the better of the two lists, blue chip only with the protocol’s own price', async () => {
    const r = await rankings([{ address: A, ranks: { cg: rank(30, 'AAA'), cp: rank(12, 'AAA') } }]);
    expect(classify(r, A)).toMatchObject({ kind: 'ranked', tier: 'blueChip', best: { rank: 12, source: 'cp' } });
    expect(classify(r, A, { priced: false })).toMatchObject({ kind: 'ranked', tier: 'top100' });
    expect(classify(r, A, { priced: null })).toMatchObject({ kind: 'ranked', tier: 'top100' });
  });

  it('places each rank in its tier', () => {
    expect([1, 21, 100, 101, 200, 201, 300, 301, 500].map((n) => rankTier(n, true))).toEqual([
      'blueChip',
      'top100',
      'top100',
      'top200',
      'top200',
      'top300',
      'top300',
      'top500',
      'top500',
    ]);
  });

  it('calls a token unverified when the lists put its symbol at different addresses', async () => {
    const r = await rankings([
      { address: A, ranks: { cg: rank(5, 'USDC') } },
      { address: B, ranks: { cp: rank(6, 'usdc') } },
    ]);
    expect(classify(r, A)).toMatchObject({ kind: 'unverified', best: { address: A }, other: { address: B, source: 'cp' } });
    expect(classify(r, B)).toMatchObject({ kind: 'unverified', other: { address: A, source: 'cg' } });
  });

  it('keeps two tokens sharing a symbol ranked when one list knows both', async () => {
    const r = await rankings([
      { address: A, ranks: { cg: rank(5, 'USDC'), cp: rank(5, 'USDC') } },
      { address: B, ranks: { cp: rank(90, 'USDC') } },
    ]);
    expect(classify(r, A)).toMatchObject({ kind: 'ranked', tier: 'blueChip' });
    expect(classify(r, B)).toMatchObject({ kind: 'ranked', tier: 'top100' });
  });

  it('labels an unranked token sharing a ranked symbol or name a possible copy, else own risk', async () => {
    const r = await rankings([
      { address: A, ranks: { cg: rank(40, 'PEPE', 'Pepe') } },
      { address: B, ranks: { cg: rank(9, 'PEPE', 'Pepe') } },
    ]);
    expect(classify(r, C, { symbol: 'pepe' })).toMatchObject({ kind: 'copy', of: { address: B, rank: 9 } });
    expect(classify(r, C, { symbol: 'XYZ', name: 'Pepe ' })).toMatchObject({ kind: 'copy', of: { address: B } });
    expect(classify(r, C, { symbol: 'XYZ' })).toEqual({ kind: 'unranked' });
    expect(classify(r, D)).toEqual({ kind: 'unranked' });
  });

  it('says a test token is one, and where no list is stored says so', async () => {
    const r = await rankings([{ address: A, ranks: { cg: rank(1, 'AAA') } }]);
    expect(classify(r, A, { testToken: true })).toEqual({ kind: 'test' });
    const none = await rankings([], { cg: { listFetchedAt: null, lastRun: null }, cp: { listFetchedAt: null, lastRun: { fetchedAt: 5, ok: false } } });
    expect(classify(none, A, { testnet: true })).toEqual({ kind: 'testNetwork' });
    expect(classify(none, A)).toEqual({ kind: 'noList' });
  });

  it('ignores a list the index does not hold when checking agreement', async () => {
    const r = await rankings([{ address: A, ranks: { cg: rank(5, 'USDC') } }], { cg: STORED, cp: { listFetchedAt: null, lastRun: null } });
    expect(classify(r, A)).toMatchObject({ kind: 'ranked' });
  });
});

describe('list age', () => {
  it('states a refresh that failed after the stored list, and the oldest list', async () => {
    const r = await rankings([], { cg: { listFetchedAt: 900, lastRun: { fetchedAt: 2_000, ok: false } }, cp: STORED });
    expect(listAge(r, 'cg')).toEqual({ asOf: 900, failedAt: 2_000 });
    expect(listAge(r, 'cp')).toEqual({ asOf: 1_000, failedAt: null });
    expect(oldestList(r)).toEqual({ source: 'cg', asOf: 900 });
  });
});

describe('searchRanked', () => {
  it('finds ranked tokens by symbol or name, best rank first', async () => {
    const r = await rankings([
      { address: A, ranks: { cg: rank(80, 'USDC.e', 'Bridged USDC') } },
      { address: B, ranks: { cg: rank(5, 'USDC', 'USD Coin'), cp: rank(7, 'USDC', 'USD Coin') } },
      { address: C, ranks: { cp: rank(2, 'WETH', 'Wrapped Ether') } },
    ]);
    expect(searchRanked(r, 'usdc').map((h) => [h.address, h.best.rank])).toEqual([
      [B, 5],
      [A, 80],
    ]);
    expect(searchRanked(r, 'wrapped').map((h) => h.address)).toEqual([C]);
    expect(searchRanked(r, 'u')).toEqual([]);
  });
});
