import { describe, expect, it } from 'vitest';
import { failingFrame } from './traceFrame';

describe('failingFrame', () => {
  it('returns undefined for a frame that did not fail', () => {
    expect(failingFrame({ calls: [{ error: 'x' }] })).toBeUndefined();
  });
  it('follows the last failed child down to the deepest failed frame', () => {
    const deep = { to: '0xc', error: 'out of gas' };
    const top = {
      error: 'execution reverted',
      calls: [
        { to: '0xa', error: 'execution reverted' }, // caught earlier, not the cause
        { to: '0xb', error: 'execution reverted', calls: [{ to: '0xok' }, deep] },
      ],
    };
    expect(failingFrame(top)).toBe(deep);
  });
  it('stops at a failed frame whose children all succeeded', () => {
    const top = { error: 'execution reverted', calls: [{ to: '0xa' }] };
    expect(failingFrame(top)).toBe(top);
  });
});
