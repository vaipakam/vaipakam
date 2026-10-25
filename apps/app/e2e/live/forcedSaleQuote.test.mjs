import { describe, expect, it } from 'vitest';
import { FORCED_SALE_KIND, forcedSaleQuoteAmount } from '@vaipakam/lib/routeBuilder';
import { TIME_BASED_DEFAULT, quoteFromPlan, readDefaultQuote } from './forcedSaleQuote.mjs';

const plan = (sell, maxSell) => ({ debt: 0n, need: 0n, sell, floor: 0n, covered: true, maxSell });

describe('live-drive forced-sale quote (#2796)', () => {
  it('quotes exactly what the app quotes', () => {
    for (const [sell, maxSell] of [
      [1_000n, 1_020n],
      [1_000n, 1_021n],
      [5_000n, 5_000n],
      [1n, 2n],
      [10n ** 18n, 10n ** 18n + 2n * 10n ** 16n],
    ]) {
      expect(quoteFromPlan(plan(sell, maxSell))).toBe(forcedSaleQuoteAmount(plan(sell, maxSell)));
    }
  });

  it('quotes 0 where the app has no sale to quote', () => {
    expect(forcedSaleQuoteAmount(plan(0n, 0n))).toBeNull();
    expect(quoteFromPlan(plan(0n, 0n))).toBe(0n);
  });

  it('asks for the time-based default plan, at the pinned block when given', async () => {
    expect(TIME_BASED_DEFAULT).toBe(FORCED_SALE_KIND.TimeBasedDefault);
    const calls = [];
    const pub = { readContract: async (req) => (calls.push(req), plan(100n, 102n)) };
    expect(await readDefaultQuote(pub, '0x1', [], 7n, 9n)).toBe(101n);
    expect(calls[0]).toMatchObject({ functionName: 'previewForcedSale', args: [7n, 3], blockNumber: 9n });
    await readDefaultQuote(pub, '0x1', [], 7n);
    expect('blockNumber' in calls[1]).toBe(false);
  });
});
