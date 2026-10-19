/**
 * How a pass spends one run's window (#2572 r5, src/runWindow.ts).
 */
import { describe, expect, it } from 'vitest';
import { readCutoffMs, runIndex, SEND_RESERVE_MS } from '../src/runWindow';

describe('runIndex', () => {
  it('counts cadence steps from the scheduled time, not the clock', () => {
    const tick = { scheduledTimeMs: 600_000, deadlineMs: 0 };
    expect(runIndex(tick, 60_000, 9_999_999)).toBe(10);
    expect(runIndex(tick, 300_000)).toBe(2);
  });

  it('reads the clock only for an invocation that is not a cron tick', () => {
    expect(runIndex({ scheduledTimeMs: undefined, deadlineMs: 0 }, 60_000, 180_000)).toBe(3);
  });
});

describe('readCutoffMs', () => {
  it('leaves the send reserve before the run deadline', () => {
    expect(readCutoffMs(100_000)).toBe(100_000 - SEND_RESERVE_MS);
  });
});
