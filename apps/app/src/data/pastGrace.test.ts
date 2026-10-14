import { describe, expect, it } from 'vitest';
import { graceVerdictFrom } from './pastGrace';

const base = {
  answer: { defaultable: true, requestedAt: 2_000 } as { defaultable: boolean; requestedAt: number } | undefined,
  isError: false,
  isPaused: false,
  validSince: 0,
};

describe('graceVerdictFrom', () => {
  it('shows the chain answer only while it is current', () => {
    expect(graceVerdictFrom(base)).toEqual({ read: 'current', verdict: true });
    expect(graceVerdictFrom({ ...base, answer: { defaultable: false, requestedAt: 2_000 } })).toEqual({
      read: 'current',
      verdict: false,
    });
  });

  it('is checking before the first answer', () => {
    expect(graceVerdictFrom({ ...base, answer: undefined })).toEqual({ read: 'checking', verdict: undefined });
  });

  it.each([
    ['an errored refresh', { isError: true }],
    ['a paused fetch', { isPaused: true }],
    ['an offline browser with no fetch attempted yet', { validSince: Number.POSITIVE_INFINITY }],
  ])('never re-shows a cached answer through %s', (_label, over) => {
    expect(graceVerdictFrom({ ...base, ...over })).toEqual({ read: 'unavailable', verdict: undefined });
  });

  it('after a remount, reconnect or refocus, counts only an answer requested after it', () => {
    // The observation began at t=3000 (row mounted, or the device came back). A reply to a request sent at t=2000 (before the
    // outage, landing late) is not current.
    expect(graceVerdictFrom({ ...base, validSince: 3_000 })).toEqual({ read: 'checking', verdict: undefined });
    // The read requested at t=3200, after reconnecting, is.
    expect(
      graceVerdictFrom({ ...base, validSince: 3_000, answer: { defaultable: true, requestedAt: 3_200 } }),
    ).toEqual({ read: 'current', verdict: true });
  });
});
