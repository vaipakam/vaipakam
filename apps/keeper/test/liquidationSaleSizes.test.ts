/**
 * #2796 — the HF liquidator quotes a full or split liquidation for only the
 * collateral the debt needs, as the contract sizes it, and compares a split
 * against the full sale per unit sold, since the two kinds are sized apart.
 */
import { describe, expect, it } from 'vitest';
import { liquidationSaleSizes, pickSplitLegs } from '../src/keeper';
import type { ServerOrchestrationResult } from '../src/serverQuotes';

const plan = (sell: bigint, maxSell: bigint) => ({
  debt: 1n,
  need: 1n,
  sell,
  floor: 1n,
  covered: sell !== maxSell,
  maxSell,
});
const NONE = plan(0n, 0n);

describe('liquidationSaleSizes', () => {
  it('quotes the middle of each kind’s range, and splits the split’s total into legs that sum to it', () => {
    const sizes = liquidationSaleSizes(plan(1000n, 1020n), plan(1001n, 1021n));
    expect(sizes).toEqual({ fullAmount: 1010n, splitTotal: 1011n, halfAmount: 505n, otherHalf: 506n });
    expect(sizes!.halfAmount + sizes!.otherHalf).toBe(sizes!.splitTotal);
  });

  it('an uncovered sale quotes its one accepted amount, the whole collateral', () => {
    expect(liquidationSaleSizes(plan(5000n, 5000n), plan(5000n, 5000n))).toMatchObject({
      fullAmount: 5000n,
      splitTotal: 5000n,
    });
  });

  it('no full sale due is no attempt; no split sale due is no split', () => {
    expect(liquidationSaleSizes(NONE, plan(1000n, 1020n))).toBeNull();
    expect(liquidationSaleSizes(plan(1000n, 1020n), NONE)).toEqual({
      fullAmount: 1010n,
      splitTotal: null,
      halfAmount: 0n,
      otherHalf: 0n,
    });
  });
});

describe('pickSplitLegs — per unit sold', () => {
  const quotes = (...legs: [string, bigint][]): ServerOrchestrationResult =>
    ({
      ranked: legs.map(([kind, expectedOutput], i) => ({ kind, expectedOutput, call: { adapterIdx: BigInt(i), data: '0x' } })),
      calls: [],
      failed: [],
      route: null,
    }) as unknown as ServerOrchestrationResult;

  it('a split that sells more is not better merely because it returns more', () => {
    // Full sells 1000 for 2000 (rate 2.0). The split sells 1100 for 2150
    // (rate ~1.95): a larger total, a worse price.
    const half = quotes(['zeroex', 1075n], ['oneinch', 1075n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1100n, full: 1000n })).toBeNull();
  });

  it('a split with a better price clears the threshold, measured per unit', () => {
    // Full: 2000 for 1000 (2.0). Split: 2100 for 1000 (2.1) → +500 bps.
    const half = quotes(['zeroex', 1050n], ['oneinch', 1050n]);
    const pick = pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1000n, full: 1000n });
    expect(pick).toMatchObject({ totalExpected: 2100n, gainBps: 500 });
  });

  it('needs two different aggregators', () => {
    const half = quotes(['zeroex', 1050n], ['zeroex', 1050n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1000n, full: 1000n })).toBeNull();
  });
});
