import { describe, expect, it } from 'vitest';
import { autoRefinancePostureFrom } from './autoRefinancePosture';

const both = { autoRefinance: true, partialFill: true };

describe('autoRefinancePostureFrom', () => {
  it('is on only when BOTH switches are read and on', () => {
    expect(autoRefinancePostureFrom({ data: both, isError: false })).toBe('on');
  });

  it('is off whenever the refinance switch is off, whatever the matcher flag', () => {
    expect(
      autoRefinancePostureFrom({
        data: { autoRefinance: false, partialFill: true },
        isError: false,
      }),
    ).toBe('off');
    expect(
      autoRefinancePostureFrom({
        data: { autoRefinance: false, partialFill: false },
        isError: false,
      }),
    ).toBe('off');
  });

  it('states the matcher is off when only the matcher master flag is off (#2355 r5)', () => {
    // The refinance switch alone does not make the matcher available:
    // matchOffers / matchIntent revert while partialFill is off.
    expect(
      autoRefinancePostureFrom({
        data: { autoRefinance: true, partialFill: false },
        isError: false,
      }),
    ).toBe('matcherOff');
  });

  it('states unknown while no answer has arrived yet (#2355 r5)', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: false })).toBe('unknown');
  });

  it('states unknown when the first read failed', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: true })).toBe('unknown');
  });

  it('states unknown after a failed re-read, never the cached answer (#2355 r4)', () => {
    // React Query keeps the last good `data` across a failed refetch; a
    // cached "on" would otherwise present a possibly-flipped switch as current.
    expect(autoRefinancePostureFrom({ data: both, isError: true })).toBe('unknown');
  });
});
