import { describe, expect, it } from 'vitest';
import {
  FORCED_SALE_KIND,
  forcedSaleQuoteAccepted,
  forcedSaleQuoteAmount,
  readForcedSalePlan,
  type ForcedSalePlan,
} from './routeBuilder';

const plan = (sell: bigint, maxSell: bigint, covered = true): ForcedSalePlan => ({
  debt: 1_000n,
  need: 1_050n,
  sell,
  floor: 1_050n,
  covered,
  maxSell,
});

describe('forcedSaleQuoteAmount (#2796)', () => {
  it('quotes the middle of a covered range', () => {
    expect(forcedSaleQuoteAmount(plan(1_000n, 1_020n))).toBe(1_010n);
  });

  it('quotes the one point of an uncovered range (all the collateral)', () => {
    expect(forcedSaleQuoteAmount(plan(5_000n, 5_000n, false))).toBe(5_000n);
  });

  it('quotes nothing when no sale is due', () => {
    expect(forcedSaleQuoteAmount(plan(0n, 0n, false))).toBeNull();
  });

  it('is always inside the accepted range', () => {
    for (const [s, m] of [
      [1n, 1n],
      [1n, 2n],
      [999n, 1_018n],
      [10n ** 24n, 10n ** 24n + 2n * 10n ** 22n],
    ] as const) {
      const p = plan(s, m);
      expect(forcedSaleQuoteAccepted(p, forcedSaleQuoteAmount(p)!)).toBe(true);
    }
  });
});

describe('forcedSaleQuoteAccepted', () => {
  it('accepts the ends and refuses outside them', () => {
    const p = plan(1_000n, 1_020n);
    expect(forcedSaleQuoteAccepted(p, 1_000n)).toBe(true);
    expect(forcedSaleQuoteAccepted(p, 1_020n)).toBe(true);
    expect(forcedSaleQuoteAccepted(p, 999n)).toBe(false);
    expect(forcedSaleQuoteAccepted(p, 1_021n)).toBe(false);
  });

  it('accepts nothing when no sale is due', () => {
    expect(forcedSaleQuoteAccepted(plan(0n, 0n, false), 0n)).toBe(false);
  });
});

describe('readForcedSalePlan', () => {
  it('reads previewForcedSale with the kind and the pinned block', async () => {
    let seen: { functionName?: string; args?: readonly unknown[]; blockNumber?: bigint } = {};
    const client = {
      readContract: async (req: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
        seen = req;
        return plan(7n, 8n);
      },
    } as unknown as Parameters<typeof readForcedSalePlan>[0]['client'];
    const out = await readForcedSalePlan({
      client,
      diamond: '0x0000000000000000000000000000000000000001',
      loanId: 3n,
      kind: FORCED_SALE_KIND.TimeBasedDefault,
      blockNumber: 99n,
    });
    expect(out.sell).toBe(7n);
    expect(seen.functionName).toBe('previewForcedSale');
    expect(seen.args).toEqual([3n, 3]);
    expect(seen.blockNumber).toBe(99n);
  });
});
