import { describe, expect, it } from 'vitest';
import { fallToLiquidation, liquidationRatio, PRICE_FALL_BPS, ratioAfterFall, whatIfLines, type WhatIfInput } from './whatIf';

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) =>
    `${k}|${Object.entries(v)
      .map(([a, b]) => `${a}=${b}`)
      .join(',')}`,
} as never;

const base: WhatIfInput = {
  side: 'borrower',
  price: { kind: 'ratio', ltvBps: 5000n, liqLtvBps: 8000n },
  interest: 100n,
  interestText: (a) => `${a} USDC`,
  fullTermInterest: false,
  graceSeconds: 86_400n,
  lateFee: null,
};

describe('price math', () => {
  it('raises the ratio by the fall, the borrowed price unchanged', () => {
    expect(ratioAfterFall(5000n, PRICE_FALL_BPS)).toBe(7142n);
    expect(ratioAfterFall(6000n, PRICE_FALL_BPS)).toBe(8571n);
  });
  it('states the fall that reaches the liquidation ratio, none once reached', () => {
    expect(fallToLiquidation(6000n, 8000n)).toBe(2500n);
    expect(fallToLiquidation(8000n, 8000n)).toBe(0n);
    expect(fallToLiquidation(5000n, 0n)).toBe(0n);
  });
  it('gives an untiered collateral tier 1’s ratio, as the loan snapshot does', () => {
    const tiers = [8000n, 8500n, 9000n] as const;
    expect([0, 1, 2, 3].map((t) => liquidationRatio(t, tiers))).toEqual([8000n, 8000n, 8500n, 9000n]);
  });
});

describe('whatIfLines', () => {
  it('says the ratio stays below the threshold, with the room left', () => {
    const lines = whatIfLines(base, copy);
    expect(lines[0]).toBe('whatIf.priceHolds|fall=30,now=50,after=71.42,liq=80');
    expect(lines[1]).toBe('whatIf.priceRoom|fall=37.5');
  });
  it('says the loan can be liquidated when the fall passes the threshold', () => {
    expect(whatIfLines({ ...base, price: { kind: 'ratio', ltvBps: 6000n, liqLtvBps: 8000n } }, copy)[0]).toMatch(/^whatIf\.priceLiquidated\|/);
  });
  it('states an illiquid pair and an unread price instead of a figure', () => {
    expect(whatIfLines({ ...base, price: { kind: 'illiquid' } }, copy)[0]).toBe('whatIf.priceIlliquid');
    expect(whatIfLines({ ...base, price: { kind: 'unread' } }, copy)[0]).toBe('whatIf.priceUnread');
  });
  it('names the grace period and each side’s early repayment', () => {
    const borrower = whatIfLines(base, copy);
    expect(borrower).toContain('whatIf.earlyProRataBorrower|half=50 USDC,full=100 USDC');
    expect(borrower.some((l) => l.startsWith('whatIf.lateBorrower|span='))).toBe(true);
    const lender = whatIfLines({ ...base, side: 'lender', fullTermInterest: true }, copy);
    expect(lender).toContain('whatIf.earlyFullLender|full=100 USDC');
    expect(lender.some((l) => l.startsWith('whatIf.lateLender|'))).toBe(true);
  });
  it('states the late-fee schedule when it was read', () => {
    const lines = whatIfLines({ ...base, lateFee: { firstDayBps: 100n, perDayBps: 50n, capBps: 500n } }, copy);
    expect(lines.some((l) => l.startsWith('whatIf.lateBorrowerFee|') && l.includes('first=1,perDay=0.5,cap=5'))).toBe(true);
  });
});
