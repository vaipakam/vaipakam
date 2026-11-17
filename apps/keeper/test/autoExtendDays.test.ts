import { describe, expect, it } from 'vitest';
import { extensionDays } from '../src/autoLifecycle';

const DAY = 86_400n;
const NOW = 1_000_000n;

describe('extensionDays', () => {
  it('refuses an unset expiry cap on either side (0 is "not set", never "no limit")', () => {
    expect(extensionDays(0n, NOW + 400n * DAY, NOW)).toBe('an expiry cap is not set');
    expect(extensionDays(NOW + 400n * DAY, 0n, NOW)).toBe('an expiry cap is not set');
  });

  it('fits inside the tighter cap, in whole days', () => {
    expect(extensionDays(NOW + 10n * DAY + 5n, NOW + 400n * DAY, NOW)).toBe(10n);
  });

  it('refuses a passed cap and a cap with no whole day left', () => {
    expect(extensionDays(NOW, NOW + 400n * DAY, NOW)).toBe('the expiry cap has passed');
    expect(extensionDays(NOW + DAY - 1n, NOW + 400n * DAY, NOW)).toBe('no whole day fits inside the expiry cap');
  });
});
