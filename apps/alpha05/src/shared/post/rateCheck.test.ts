import { describe, expect, it } from 'vitest';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { TLIQ, WETH } from '../offers/testOffer';
import { RATE_SAMPLE, RATE_WINDOW_DAYS, medianBps, rateVerdict, readRecentRates } from './rateCheck';

const NOW = 1_800_000_000;
const DAY = 86_400;
const NONE = { count: 0, capped: false };

function client(body: unknown, seen: string[] = []): IndexerClient {
  return {
    origin: 'https://index.test',
    async getJson<T>(path: string): Promise<T> {
      seen.push(path);
      return body as T;
    },
  };
}

function scope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { lendingAsset: WETH.toLowerCase(), collateralAsset: TLIQ.toLowerCase(), durationDays: 30, placement: 'x', excludeSaleVehicles: true, ...over };
}

function loan(rate: unknown, ageDays = 1): Record<string, unknown> {
  return { initRateBps: rate, startAt: NOW - ageDays * DAY, isSaleVehicle: false };
}

describe('readRecentRates', () => {
  it('asks for the pair and term, sale vehicles excluded, lowercased', async () => {
    const seen: string[] = [];
    await readRecentRates(client({ loans: [], scope: scope(), unplaced: NONE }, seen), 84532, WETH, TLIQ, 30n, NOW);
    expect(seen[0]).toContain(`lendingAsset=${WETH.toLowerCase()}`);
    expect(seen[0]).toContain(`collateralAsset=${TLIQ.toLowerCase()}`);
    expect(seen[0]).toContain('durationDays=30');
    expect(seen[0]).toContain('excludeSaleVehicles=1');
    expect(seen[0]).toContain(`limit=${RATE_SAMPLE}`);
  });

  it('keeps only backed rates inside the window', async () => {
    const r = await readRecentRates(
      client({ loans: [loan(800), loan(null), loan('1200', 5), loan(300, RATE_WINDOW_DAYS + 1)], scope: scope(), unplaced: NONE }),
      84532,
      WETH,
      TLIQ,
      30n,
      NOW,
    );
    expect(r).toEqual({ rates: [800n, 1200n], capped: false, unplaced: NONE });
  });

  it('says when the read reached its sample cap', async () => {
    const loans = Array.from({ length: RATE_SAMPLE }, () => loan(500));
    const r = await readRecentRates(client({ loans, scope: scope(), unplaced: NONE }), 84532, WETH, TLIQ, 30n, NOW);
    expect(r.capped).toBe(true);
  });

  it.each([
    ['no scope', undefined],
    ['another lending asset', scope({ lendingAsset: TLIQ.toLowerCase() })],
    ['another collateral asset', scope({ collateralAsset: WETH.toLowerCase() })],
    ['another term', scope({ durationDays: 60 })],
    ['sale vehicles kept', scope({ excludeSaleVehicles: false })],
  ])('refuses an answer with %s', async (_why, s) => {
    await expect(readRecentRates(client({ loans: [loan(500)], scope: s, unplaced: NONE }), 84532, WETH, TLIQ, 30n, NOW)).rejects.toBeInstanceOf(IndexerUnavailable);
  });

  it('carries the count of loans whose terms the index has not confirmed, and refuses an answer without it', async () => {
    const r = await readRecentRates(client({ loans: [], scope: scope(), unplaced: { count: 3, capped: true } }), 84532, WETH, TLIQ, 30n, NOW);
    expect(r.unplaced).toEqual({ count: 3, capped: true });
    for (const unplaced of [undefined, null, { count: -1, capped: false }, { count: 2 }]) {
      await expect(readRecentRates(client({ loans: [], scope: scope(), unplaced }), 84532, WETH, TLIQ, 30n, NOW)).rejects.toBeInstanceOf(IndexerUnavailable);
    }
  });

  it('refuses a rate that is not a whole number, and a loan with no start', async () => {
    await expect(readRecentRates(client({ loans: [loan(5.5)], scope: scope(), unplaced: NONE }), 84532, WETH, TLIQ, 30n, NOW)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readRecentRates(client({ loans: [{ initRateBps: 500 }], scope: scope(), unplaced: NONE }), 84532, WETH, TLIQ, 30n, NOW)).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });
});

describe('medianBps', () => {
  it('is null for no rates, the middle for odd, the lower middle for even', () => {
    expect(medianBps([])).toBeNull();
    expect(medianBps([900n, 100n, 500n])).toBe(500n);
    expect(medianBps([900n, 100n, 500n, 700n])).toBe(500n);
  });
});

describe('rateVerdict', () => {
  it('has nothing to say with no recent loans', () => {
    expect(rateVerdict(800n, [])).toEqual({ kind: 'none' });
  });

  it('is near within five points either side, the edge included', () => {
    expect(rateVerdict(1300n, [800n])).toEqual({ kind: 'near', median: 800n, count: 1 });
    expect(rateVerdict(300n, [800n])).toEqual({ kind: 'near', median: 800n, count: 1 });
  });

  it('is far beyond five points, saying which side', () => {
    expect(rateVerdict(1301n, [800n, 800n])).toEqual({ kind: 'far', median: 800n, count: 2, above: true });
    expect(rateVerdict(299n, [800n])).toEqual({ kind: 'far', median: 800n, count: 1, above: false });
  });
});
