/** #2389 r8 — a failed refetch disqualifies the cached answer. */
import { describe, expect, it } from 'vitest';
import { freshData } from './freshData';

describe('freshData', () => {
  it('returns the data of a successful read', () => {
    expect(freshData({ data: 7, isError: false })).toBe(7);
  });
  it('drops cached data once the latest fetch failed', () => {
    expect(freshData({ data: 7, isError: true })).toBeUndefined();
  });
  it('is undefined before any answer', () => {
    expect(freshData({ data: undefined, isError: false })).toBeUndefined();
  });
});
