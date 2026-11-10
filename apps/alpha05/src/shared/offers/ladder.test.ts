import { describe, expect, it } from 'vitest';
import { applyLimits, parseLimit, rateLadder } from './ladder';
import type { Ltv, MatchRow } from './matches';
import { offer } from './testOffer';

const E18 = 10n ** 18n;

function row(id: number, rateBps: bigint, amount: bigint, ltv: Ltv = { kind: 'bps', bps: 5000n }): MatchRow {
  return {
    offer: offer({ id: BigInt(id), interestRateBps: rateBps, amount, amountMax: amount }),
    state: 'open',
    preview: null,
    ltv,
    blocked: null,
  };
}

describe('the borrower limits', () => {
  const rows = [row(1, 400n, E18), row(2, 600n, E18, { kind: 'bps', bps: 8000n }), row(3, 450n, E18, { kind: 'illiquid' })];
  it('hide offers above the highest rate and count them', () => {
    const f = applyLimits(rows, { maxRateBps: 500n, maxLtvBps: null });
    expect(f.shown.map((r) => r.offer.id)).toEqual([1n, 3n]);
    expect(f.aboveRate).toBe(1);
    expect(f.aboveLtv).toBe(0);
  });
  it('keep an offer whose loan-to-value is not a figure, and count it apart', () => {
    const f = applyLimits(rows, { maxRateBps: null, maxLtvBps: 6000n });
    expect(f.shown.map((r) => r.offer.id)).toEqual([1n, 3n]);
    expect(f.aboveLtv).toBe(1);
    expect(f.ltvUnchecked).toBe(1);
  });
  it('change nothing without a limit', () => {
    const f = applyLimits(rows, { maxRateBps: null, maxLtvBps: null });
    expect(f.shown).toHaveLength(3);
    expect(f.aboveRate + f.aboveLtv + f.ltvUnchecked).toBe(0);
  });
});

describe('the rate ladder', () => {
  it('groups offers by rate, lowest first, keeping the list order within a step', () => {
    const steps = rateLadder([row(1, 600n, 2n * E18), row(2, 400n, E18), row(3, 600n, 5n * E18), row(4, 400n, 3n * E18)]);
    expect(steps.map((s) => s.rateBps)).toEqual([400n, 600n]);
    expect(steps[0]!.rows.map((r) => r.offer.id)).toEqual([2n, 4n]);
    expect(steps[1]).toMatchObject({ minAmount: 2n * E18, maxAmount: 5n * E18 });
  });
  it('is empty for no offers', () => {
    expect(rateLadder([])).toEqual([]);
  });
});

describe('a typed limit', () => {
  it('reads a percentage as basis points, empty as none and zero as zero', () => {
    expect(parseLimit('4.5')).toEqual({ ok: true, value: 450n });
    expect(parseLimit(' ')).toEqual({ ok: true, value: null });
    expect(parseLimit('0')).toEqual({ ok: true, value: 0n });
    expect(parseLimit('abc')).toEqual({ ok: false });
    expect(parseLimit('4.555')).toEqual({ ok: false });
  });
});
