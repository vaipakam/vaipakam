import { describe, expect, it } from 'vitest';
import { graceVerdictFrom } from './pastGrace';

const base = {
  data: true as boolean | undefined,
  dataUpdatedAt: 2_000,
  isError: false,
  isPaused: false,
  connectedSince: 0,
};

describe('graceVerdictFrom', () => {
  it('shows the chain answer only while it is current', () => {
    expect(graceVerdictFrom(base)).toEqual({ read: 'current', verdict: true });
    expect(graceVerdictFrom({ ...base, data: false })).toEqual({ read: 'current', verdict: false });
  });

  it('is checking before the first answer', () => {
    expect(graceVerdictFrom({ ...base, data: undefined })).toEqual({ read: 'checking', verdict: undefined });
  });

  it.each([
    ['an errored refresh', { isError: true }],
    ['a paused fetch', { isPaused: true }],
    ['an offline browser with no fetch attempted yet', { connectedSince: Number.POSITIVE_INFINITY }],
  ])('never re-shows a cached answer through %s', (_label, over) => {
    expect(graceVerdictFrom({ ...base, ...over })).toEqual({ read: 'unavailable', verdict: undefined });
  });

  it('does not restore a pre-disconnect answer on reconnect until a new read lands', () => {
    // Back online at t=3000; the cached answer is from t=2000.
    expect(graceVerdictFrom({ ...base, connectedSince: 3_000 })).toEqual({ read: 'checking', verdict: undefined });
    // The post-reconnect read completes at t=3500.
    expect(graceVerdictFrom({ ...base, connectedSince: 3_000, dataUpdatedAt: 3_500 })).toEqual({
      read: 'current',
      verdict: true,
    });
  });
});
