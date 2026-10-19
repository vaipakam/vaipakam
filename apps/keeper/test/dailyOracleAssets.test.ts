/**
 * The daily snapshot's asset list takes only well-formed, non-zero addresses
 * (src/dailyOracleSnapshot.ts `snapshotAssets`). On 2026-10-16 a `'0x'` stub
 * placeholder in Base Sepolia's rows made the whole chain's snapshot fail.
 */
import { describe, expect, it } from 'vitest';
import { captureDeadlineMs, snapshotAssets } from '../src/dailyOracleSnapshot';

const A = '0x4200000000000000000000000000000000000006';
const B = '0x9690108160d375539A1C5f493993d848EA239f7c';

describe('snapshotAssets', () => {
  it('drops placeholders, the zero address and anything malformed, and keeps real assets', () => {
    expect(
      snapshotAssets(['0x', '', '0x0000000000000000000000000000000000000000', 'not-an-address', '0x1234', A, B], 84532),
    ).toEqual([A.toLowerCase(), B.toLowerCase()]);
  });

  it('deduplicates case-insensitively', () => {
    expect(snapshotAssets([B, B.toLowerCase(), B.toUpperCase().replace('0X', '0x')], 84532)).toEqual([B.toLowerCase()]);
  });
});

describe('captureDeadlineMs (#2572 r4)', () => {
  it('is the end of the UTC day being captured, less the run margin', () => {
    const day = 20_380;
    expect(captureDeadlineMs(day)).toBe((day + 1) * 86_400_000 - 30_000);
  });

  it('leaves a capture queued in the last window minute room to land', () => {
    const day = 20_380;
    const lastWindowRun = day * 86_400_000 + 9 * 60_000;
    expect(captureDeadlineMs(day) - lastWindowRun).toBeGreaterThan(23 * 3_600_000);
  });
});
