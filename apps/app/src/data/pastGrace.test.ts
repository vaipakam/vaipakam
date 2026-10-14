import { describe, expect, it } from 'vitest';
import { graceVerdictFrom } from './pastGrace';

const base = { data: true as boolean | undefined, isError: false, isPaused: false, online: true };

describe('graceVerdictFrom', () => {
  it('shows the chain answer of the live query', () => {
    expect(graceVerdictFrom(base)).toEqual({ read: 'current', verdict: true });
    expect(graceVerdictFrom({ ...base, data: false })).toEqual({ read: 'current', verdict: false });
  });

  it('is checking before the first answer of this observation', () => {
    expect(graceVerdictFrom({ ...base, data: undefined })).toEqual({ read: 'checking', verdict: undefined });
  });

  it.each([
    ['an errored refresh', { isError: true }],
    ['a paused fetch', { isPaused: true }],
    ['an offline browser', { online: false }],
  ])('never shows a remembered answer through %s', (_label, over) => {
    expect(graceVerdictFrom({ ...base, ...over })).toEqual({ read: 'unavailable', verdict: undefined });
  });
});
