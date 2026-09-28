import { describe, expect, it } from 'vitest';
import { autoRefinancePostureFrom } from './autoRefinancePosture';

describe('autoRefinancePostureFrom', () => {
  it('states the answer the chain gave', () => {
    expect(autoRefinancePostureFrom({ data: true, isError: false })).toBe('on');
    expect(autoRefinancePostureFrom({ data: false, isError: false })).toBe('off');
  });

  it('shows nothing while the first read is in flight', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: false })).toBeUndefined();
  });

  it('states unknown when the first read failed', () => {
    expect(autoRefinancePostureFrom({ data: undefined, isError: true })).toBe('unknown');
  });

  it('states unknown after a failed re-read, never the cached answer (#2355 r4)', () => {
    // React Query keeps the last good `data` across a failed refetch; a
    // cached "on" would otherwise hide the disclosure through an outage
    // that spans a governance flip.
    expect(autoRefinancePostureFrom({ data: true, isError: true })).toBe('unknown');
    expect(autoRefinancePostureFrom({ data: false, isError: true })).toBe('unknown');
  });
});
