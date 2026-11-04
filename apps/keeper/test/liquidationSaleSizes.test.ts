/**
 * #2796 — the HF liquidator quotes a full or split liquidation for only the
 * collateral the debt needs, as the contract sizes it, and compares a split
 * against the full sale per unit sold, since the two kinds are sized apart.
 */
import { describe, expect, it } from 'vitest';
import { liquidationSaleSizes, pickSplitLegs, splitLegFloor } from '../src/keeper';
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
/** A split plan whose floor binds no leg. */
const NO_FLOOR = { floor: 0n, sell: 1n };

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
      ranked: legs.map(([kind, expectedOutput], i) => ({ kind, expectedOutput, call: { adapterIdx: BigInt(i), data: '0x' }, adapter: '0x00000000000000000000000000000000000000a1' })),
      calls: [],
      failed: [],
      route: null,
    }) as unknown as ServerOrchestrationResult;

  it('a split that sells more is not better merely because it returns more', () => {
    // Full sells 1000 for 2000 (rate 2.0). The split sells 1100 for 2150
    // (rate ~1.95): a larger total, a worse price.
    const half = quotes(['zeroex', 1075n], ['oneinch', 1075n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1100n, full: 1000n, legs: [550n, 550n], splitPlan: NO_FLOOR })).toBeNull();
  });

  it('a split with a better price clears the threshold, measured per unit', () => {
    // Full: 2000 for 1000 (2.0). Split: 2100 for 1000 (2.1) → +500 bps.
    const half = quotes(['zeroex', 1050n], ['oneinch', 1050n]);
    const pick = pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1000n, full: 1000n, legs: [500n, 500n], splitPlan: NO_FLOOR });
    expect(pick).toMatchObject({ totalExpected: 2100n, gainBps: 500 });
  });

  it('needs two different aggregators', () => {
    const half = quotes(['zeroex', 1050n], ['zeroex', 1050n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1000n, full: 1000n, legs: [500n, 500n], splitPlan: NO_FLOOR })).toBeNull();
  });
});

describe('pickSplitLegs — every leg clears its own share of the floor (#2724)', () => {
  const quotes = (...legs: [string, bigint][]): ServerOrchestrationResult =>
    ({
      ranked: legs.map(([kind, expectedOutput], i) => ({ kind, expectedOutput, call: { adapterIdx: BigInt(i), data: '0x' }, adapter: '0x00000000000000000000000000000000000000a1' })),
      calls: [],
      failed: [],
      route: null,
    }) as unknown as ServerOrchestrationResult;
  // Floor rate 2.0: 2000 for 1000 sold, so a 500 leg needs 1000.
  const floor2 = { floor: 2000n, sell: 1000n };

  it('a leg share is the contract rule, rounded up', () => {
    expect(splitLegFloor({ floor: 900n, sell: 1000n }, 300n)).toBe(270n);
    expect(splitLegFloor({ floor: 901n, sell: 1000n }, 300n)).toBe(271n); // 270.3 rounds up
    expect(splitLegFloor({ floor: 0n, sell: 0n }, 300n)).toBe(0n);
  });

  it('refuses a pair whose total clears but one leg falls short of its share', () => {
    // 1300 + 950 = 2250 beats the full 2050, but the 950 leg is under its 1000.
    const half = quotes(['zeroex', 1300n], ['oneinch', 950n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 2050n]), 100, { split: 1000n, full: 1000n, legs: [500n, 500n], splitPlan: floor2 })).toBeNull();
  });

  it('takes the best pair whose legs each clear, not just the top quote', () => {
    // The top 1inch leg is short; a second 1inch quote clears and pairs with 0x.
    const half = quotes(['zeroex', 1150n], ['oneinch', 1200n], ['oneinch', 1050n]);
    const pick = pickSplitLegs(half, quotes(['zeroex', 2000n]), 100, { split: 1000n, full: 1000n, legs: [500n, 500n], splitPlan: { floor: 2200n, sell: 1000n } });
    // Floor 1100 per leg: 1200 (1inch) + 1150 (0x) both clear.
    expect(pick).toMatchObject({ totalExpected: 2350n });
    expect([pick!.a.kind, pick!.b.kind].sort()).toEqual(['oneinch', 'zeroex']);
  });

  it('sizes each leg by what it sells', () => {
    // Legs 505 and 506 at rate 2.0: shares 1010 and 1012.
    const half = quotes(['zeroex', 1011n], ['oneinch', 1011n]);
    expect(pickSplitLegs(half, quotes(['zeroex', 1900n]), 100, { split: 1011n, full: 1000n, legs: [505n, 506n], splitPlan: floor2 })).toBeNull();
  });
});
