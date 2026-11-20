/** #3751 — the rate curve reads refuse an answer that is not the shape asked
 *  for, keep a missing figure missing, and state the rule as the index sent it. */
import { describe, expect, it } from 'vitest';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { parseRateCurve, parseRateHistory, parseRule, referenceNotPublished } from './curve';
import { curveAnswer, historyAnswer } from './curveFixture';

const ASSET = '0x00000000000000000000000000000000000000e1' as const;
const NOW = 1_900_000_000;

describe('parseRateCurve', () => {
  it('reads the index answer: the day, both halves and the rule', () => {
    const c = parseRateCurve(curveAnswer(84532, ASSET, NOW), { chainId: 84532, asset: ASSET });
    expect(c.asOf).toBe(NOW);
    expect(c.day).toBe(Math.floor(NOW / 86_400) * 86_400);
    expect(referenceNotPublished(c)).toBe(true);
    expect(c.ownLoans.terms.map((t) => t.state)).toEqual(['withheld', 'shown', 'withheld', 'withheld', 'withheld']);
    expect(c.ownLoans.terms[4].termRange).toEqual([271, null]);
    expect(c.ownLoans.rule.provisional).toBe(true);
    expect(c.ownLoans.rule.settings.map((s) => s.key)).toEqual([
      'lookbackMinDays',
      'lookbackTermMultiple',
      'minAgeDays',
      'walletShareCapBps',
      'minLenders',
      'minBorrowers',
      'loans',
      'weight',
      'figure',
    ]);
    expect(c.ownLoans.rule.points[2]).toEqual({ days: 90, termRange: [61, 135], lookbackDays: 180 });
  });

  it('refuses an answer for another network or asset', () => {
    expect(() => parseRateCurve(curveAnswer(1, ASSET, NOW), { chainId: 84532, asset: ASSET })).toThrow(IndexerUnavailable);
    expect(() => parseRateCurve(curveAnswer(84532, '0x' + '2'.repeat(40), NOW), { chainId: 84532, asset: ASSET })).toThrow(/another network or asset/);
  });

  it('refuses a shown point with no median, an unknown state and a nested rule setting', () => {
    const a = curveAnswer(84532, ASSET, NOW);
    (a.ownLoans.terms[1] as { medianBps: number | null }).medianBps = null;
    expect(() => parseRateCurve(a, { chainId: 84532, asset: ASSET })).toThrow(/shown with no median/);
    const b = curveAnswer(84532, ASSET, NOW);
    (b.ownLoans.terms[0] as { state: string }).state = 'zero';
    expect(() => parseRateCurve(b, { chainId: 84532, asset: ASSET })).toThrow(/state/);
    expect(() => parseRule({ cap: { a: 1 } })).toThrow(/rule setting cap/);
  });

  it('keeps an uncomputed asset uncomputed, with no time', () => {
    const a = { ...curveAnswer(84532, ASSET, NOW), computed: false, day: null, asOf: null };
    const c = parseRateCurve(a, { chainId: 84532, asset: ASSET });
    expect(c.computed).toBe(false);
    expect(c.asOf).toBeNull();
  });

  it('reads a published reference figure as published', () => {
    const a = curveAnswer(84532, ASSET, NOW);
    a.reference.terms[0] = { days: 7, state: 'available', valueBps: 610, a24Bps: 610, a90Bps: 550, weightBps: 10_000 } as never;
    expect(referenceNotPublished(parseRateCurve(a, { chainId: 84532, asset: ASSET }))).toBe(false);
  });
});

describe('unconfirmed loans left out', () => {
  it('reads the count, keeps a missing one missing and refuses one that is not a number', () => {
    const c = parseRateCurve(curveAnswer(84532, ASSET, NOW), { chainId: 84532, asset: ASSET });
    expect(c.ownLoans.terms.map((t) => t.unconfirmedLeftOut)).toEqual([0, 2, 0, 0, 0]);
    const a = curveAnswer(84532, ASSET, NOW);
    delete (a.ownLoans.terms[1] as Record<string, unknown>).unconfirmedLeftOut;
    expect(parseRateCurve(a, { chainId: 84532, asset: ASSET }).ownLoans.terms[1].unconfirmedLeftOut).toBeNull();
    (a.ownLoans.terms[1] as Record<string, unknown>).unconfirmedLeftOut = '3';
    expect(() => parseRateCurve(a, { chainId: 84532, asset: ASSET })).toThrow(IndexerUnavailable);
    const h = parseRateHistory(historyAnswer(84532, ASSET, 30, 20_000), { chainId: 84532, asset: ASSET, days: 30 });
    expect(h.rows.every((r) => typeof r.ownLoans.unconfirmedLeftOut === 'number')).toBe(true);
  });
});

describe('parseRateHistory', () => {
  it('lists only the filled days, newest first, in seconds', () => {
    const today = Math.floor(NOW / 86_400);
    const h = parseRateHistory(historyAnswer(84532, ASSET, 30, today), { chainId: 84532, asset: ASSET, days: 30 });
    expect(h.rows.map((r) => r.day / 86_400)).toEqual([today, today - 2, today - 3]);
    expect(h.rows[2].ownLoans.reason).toBe('not-enough-loans');
    expect(h.termRange).toEqual([15, 60]);
  });

  it('refuses a history for another term', () => {
    expect(() => parseRateHistory(historyAnswer(84532, ASSET, 90, 20_000), { chainId: 84532, asset: ASSET, days: 30 })).toThrow(/another network, asset or term/);
  });
});
