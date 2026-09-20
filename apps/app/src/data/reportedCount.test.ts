/**
 * `isReportedCount` — the one definition of "may this page publish this
 * figure", now that there is one.
 *
 * The bug this pins (round 54 P2): the Analytics tile tested
 * `typeof value === 'number'` while `resolveActiveSplit` tested finite,
 * non-negative. So a wire response carrying a negative counter had the
 * DERIVED residual withheld and the invalid counter itself printed
 * beside it — the page suppressed the consequence of bad input while
 * presenting the input. Every case below is one of the two callers
 * agreeing with the other.
 */
import { describe, expect, it } from 'vitest';
import { isReportedCount, reportedCount } from './reportedCount';

describe('isReportedCount — publishable', () => {
  it('accepts a positive count', () => {
    expect(isReportedCount(7)).toBe(true);
  });

  // Zero must pass. An empty deployment reports zero honestly, and
  // treating that as a gap is the failure in the opposite direction from
  // the one this predicate exists for.
  it('accepts zero', () => {
    expect(isReportedCount(0)).toBe(true);
  });

  it('accepts a large but exact count', () => {
    expect(isReportedCount(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('isReportedCount — withheld', () => {
  it('rejects an absent field', () => {
    expect(isReportedCount(undefined)).toBe(false);
  });

  // NaN compares false against every bound, so a predicate written as
  // `value >= 0` alone waves it through and it reaches the reader as the
  // string "NaN" on a page about trustworthy figures.
  it('rejects NaN', () => {
    expect(isReportedCount(Number.NaN)).toBe(false);
  });

  it('rejects an infinity in either direction', () => {
    expect(isReportedCount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isReportedCount(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('rejects a negative count', () => {
    expect(isReportedCount(-1)).toBe(false);
  });

  // A fractional count of loans was not rounded; it was produced by
  // something other than counting, and inherits whatever that was.
  it('rejects a fractional count', () => {
    expect(isReportedCount(2.5)).toBe(false);
  });

  // Beyond 2^53 an integer is no longer exactly representable, so the
  // figure rendered would not be the figure meant.
  it('rejects a value past exact integer representation', () => {
    expect(isReportedCount(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });
});

describe('reportedCount', () => {
  it('passes a publishable value through', () => {
    expect(reportedCount(0)).toBe(0);
    expect(reportedCount(12)).toBe(12);
  });

  // Collapses every withheld case to `undefined`, which is what the
  // components' own "not reported" branch already keys on — so a caller
  // does not restate the rule.
  it('collapses every withheld case to undefined', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5]) {
      expect(reportedCount(bad)).toBeUndefined();
    }
  });
});
