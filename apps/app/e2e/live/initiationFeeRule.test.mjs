/**
 * #3649 — the live drives' copy of the initiation-fee term rule is the app's
 * rule: every figure matches `src/lib/initiationFee.ts` over a grid of
 * settings and terms (including both kinks and past the one-year point).
 */
import { describe, expect, it } from 'vitest';

import * as app from '../../src/lib/initiationFee';
import { lifFeeOf, lifRateBpsUp, lifRateFraction, lifRatePercentText, lifTermsOf } from './initiationFeeRule.mjs';

const SETTINGS = [
  [20, 30, 50, 365],
  [20, 1, 20, 180],
  [7, 90, 730, 730],
  [0, 30, 50, 365],
];
const TERMS = [0, 1, 7, 29, 30, 31, 60, 90, 180, 364, 365, 366, 730, 1000];
const AMOUNTS = [1n, 999n, 10n ** 18n, 5_000_000_000_000_000n];

describe('initiationFeeRule — the app rule, for the live drives', () => {
  for (const s of SETTINGS) {
    const terms = lifTermsOf(s);
    const appTerms = { baseBps: s[0], baseTermDays: s[1], yearlyBps: s[2], yearDays: s[3] };
    it(`agrees with the app at ${s.join('/')}`, () => {
      for (const t of TERMS) {
        expect(lifRateFraction(terms, t)).toEqual(app.lifRateFraction(appTerms, t));
        expect(Number(lifRateBpsUp(terms, t))).toBe(app.lifRateBpsUp(appTerms, t));
        expect(lifRatePercentText(terms, t)).toBe(app.lifRatePercentText(appTerms, t));
        for (const a of AMOUNTS) expect(lifFeeOf(a, terms, t)).toBe(app.lifFeeOf(a, appTerms, t));
      }
    });
  }

  it('reads the tuple in output order and refuses another shape', () => {
    expect(lifTermsOf([20n, 30n, 50n, 365n])).toEqual({ baseBps: 20n, baseTermDays: 30n, yearlyBps: 50n, yearDays: 365n });
    expect(() => lifTermsOf(20n)).toThrow();
  });

  it('is the base rate up to the base term and higher past it', () => {
    const t = lifTermsOf([20, 30, 50, 365]);
    expect(lifRatePercentText(t, 30)).toBe('0.2');
    expect(lifRatePercentText(t, 365)).toBe('0.5');
    expect(lifFeeOf(10n ** 18n, t, 730)).toBe(10n ** 16n);
  });
});
