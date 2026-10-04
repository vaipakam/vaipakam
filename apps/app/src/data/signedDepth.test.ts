/** #2386 — the desk names what it knows about the signed book. */
import { describe, expect, it } from 'vitest';
import { signedDepthOf } from './signedDepth';

describe('signedDepthOf', () => {
  it('is loading before the signed book answers', () => {
    expect(signedDepthOf({ data: undefined, isError: false })).toBe('loading');
  });
  it('is unavailable when the service did not answer', () => {
    expect(signedDepthOf({ data: null, isError: false })).toBe('unavailable');
  });
  it('is unavailable when the latest refetch failed, even with a cached book', () => {
    expect(signedDepthOf({ data: { truncated: false }, isError: true })).toBe('unavailable');
  });
  it('is partial when the service says it cut depth', () => {
    expect(signedDepthOf({ data: { truncated: true }, isError: false })).toBe('partial');
  });
  it('is partial — never complete — when the service did not report the flag (r1)', () => {
    expect(signedDepthOf({ data: { truncated: null }, isError: false })).toBe('partial');
  });
  it('is complete only on an explicit false', () => {
    expect(signedDepthOf({ data: { truncated: false }, isError: false })).toBe('complete');
  });
});
