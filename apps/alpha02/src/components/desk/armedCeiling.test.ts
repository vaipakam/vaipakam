import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { armedCeilingOf, shouldWarnCeilingBelowQuote } from './armedCeiling';

const v = (s: string) => parseUnits(s, 18);

describe('armedCeilingOf', () => {
  it('reads a well-formed ceiling while Full is opted into', () => {
    expect(armedCeilingOf({ full: true, ceiling: '1.5' })).toBe(v('1.5'));
  });
  it('is undefined when Full is not opted into — nothing is being authorized', () => {
    expect(armedCeilingOf({ full: false, ceiling: '1.5' })).toBeUndefined();
  });
  it('is undefined for a blank or malformed field, which is a separate validation failure', () => {
    expect(armedCeilingOf({ full: true, ceiling: '' })).toBeUndefined();
    expect(armedCeilingOf({ full: true, ceiling: '1.2.3' })).toBeUndefined();
    // Exponential notation is what a naive Number()/2 produces, and the form's
    // own guard rejects it (#1700 r2 hit exactly this in a spec).
    expect(armedCeilingOf({ full: true, ceiling: '1e-17' })).toBeUndefined();
  });
  it('treats zero as no ceiling — the contract requires a positive one', () => {
    expect(armedCeilingOf({ full: true, ceiling: '0' })).toBeUndefined();
  });
  it('is undefined when the form has not seeded yet', () => {
    expect(armedCeilingOf(null)).toBeUndefined();
  });
});

describe('shouldWarnCeilingBelowQuote', () => {
  const base = { armAllowed: true, quoted: v('2'), armedCeiling: v('1') };

  it('warns when the live quote has passed the ceiling', () => {
    expect(shouldWarnCeilingBelowQuote(base)).toBe(true);
  });
  it('does not warn when the ceiling exactly meets the quote', () => {
    expect(shouldWarnCeilingBelowQuote({ ...base, armedCeiling: v('2') })).toBe(false);
  });
  it('does not warn when the ceiling is above the quote', () => {
    expect(shouldWarnCeilingBelowQuote({ ...base, armedCeiling: v('3') })).toBe(false);
  });
  it('stays SILENT while arming is unavailable — otherwise "you can save this either way" sits beside a disabled Save (#1703 r1)', () => {
    expect(shouldWarnCeilingBelowQuote({ ...base, armAllowed: false })).toBe(false);
  });
  it('stays silent with no quote yet — an unread quote is not an exceeded ceiling', () => {
    expect(shouldWarnCeilingBelowQuote({ ...base, quoted: undefined })).toBe(false);
  });
  it('stays silent with no ceiling expressed — that is the maxCStarRequired path, not this one', () => {
    expect(shouldWarnCeilingBelowQuote({ ...base, armedCeiling: undefined })).toBe(false);
  });
  it('warns on a sub-display-precision overtake, which formatted figures would hide (#1700 r1)', () => {
    expect(
      shouldWarnCeilingBelowQuote({
        armAllowed: true,
        quoted: v('1.00002'),
        armedCeiling: v('1.00001'),
      }),
    ).toBe(true);
  });
});
