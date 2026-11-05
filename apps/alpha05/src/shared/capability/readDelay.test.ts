import { describe, expect, it } from 'vitest';
import { RETRY_MS, SNAPSHOT_TTL_MS, nextReadDelayMs } from './CapabilityContext';

describe('nextReadDelayMs', () => {
  it('re-reads a good snapshot at its expiry and a failed read much sooner', () => {
    expect(nextReadDelayMs(false)).toBe(SNAPSHOT_TTL_MS);
    expect(nextReadDelayMs(true)).toBe(RETRY_MS);
    expect(RETRY_MS).toBeLessThan(SNAPSHOT_TTL_MS);
  });
});
