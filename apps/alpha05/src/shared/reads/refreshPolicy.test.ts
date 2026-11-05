import { describe, expect, it } from 'vitest';
import { OWN_REFRESH_MS, ownRefreshIntervalMs } from './refreshPolicy';

describe('ownRefreshIntervalMs', () => {
  it('refreshes every minute while visible and not at all while hidden', () => {
    expect(ownRefreshIntervalMs(true)).toBe(OWN_REFRESH_MS);
    expect(OWN_REFRESH_MS).toBe(60_000);
    expect(ownRefreshIntervalMs(false)).toBe(false);
  });
});
