import { describe, expect, it } from 'vitest';
import { autoRefinancePostureFrom } from './autoRefinancePosture';

const live = { paused: false, autoRefinance: true, partialFill: true };

describe('autoRefinancePostureFrom', () => {
  it('is on only when unpaused and BOTH matcher switches are on', () => {
    expect(autoRefinancePostureFrom({ data: live, isError: false })).toBe('on');
  });

  it('is off when the refinance switch is off', () => {
    expect(
      autoRefinancePostureFrom({ data: { ...live, autoRefinance: false }, isError: false }),
    ).toBe('off');
  });

  it('is off when only the matcher master flag is off (#2355 r5)', () => {
    // matchOffers / matchIntent revert while partialFill is off, whatever
    // the refinance switch says, so the matcher cannot fill the request.
    expect(
      autoRefinancePostureFrom({ data: { ...live, partialFill: false }, isError: false }),
    ).toBe('off');
  });

  it('states the pause over every switch setting (#2355 r6)', () => {
    // Every refinance completion is whenNotPaused — a lender's direct
    // accept included — so "on" or "off" would both misstate it.
    expect(
      autoRefinancePostureFrom({ data: { ...live, paused: true }, isError: false }),
    ).toBe('paused');
    expect(
      autoRefinancePostureFrom({
        data: { paused: true, autoRefinance: false, partialFill: false },
        isError: false,
      }),
    ).toBe('paused');
  });

  it('states unknown while no answer has arrived yet (#2355 r5)', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: false })).toBe('unknown');
  });

  it('states unknown when the first read failed', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: true })).toBe('unknown');
  });

  it('states unknown after a failed re-read, never the cached answer (#2355 r4)', () => {
    expect(autoRefinancePostureFrom({ data: live, isError: true })).toBe('unknown');
    expect(
      autoRefinancePostureFrom({ data: { ...live, paused: true }, isError: true }),
    ).toBe('unknown');
  });
});
