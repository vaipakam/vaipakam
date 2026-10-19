/**
 * How a pass spends one run's window (#2572 r5, src/runWindow.ts).
 */
import { describe, expect, it } from 'vitest';
import { readCutoffMs, rotated, runIndex, SEND_RESERVE_MS } from '../src/runWindow';

describe('rotated', () => {
  it('starts successive runs at successive items, wrapping round', () => {
    const items = ['a', 'b', 'c'];
    expect(rotated(items, 0)).toEqual(['a', 'b', 'c']);
    expect(rotated(items, 1)).toEqual(['b', 'c', 'a']);
    expect(rotated(items, 5)).toEqual(['c', 'a', 'b']);
  });

  it('puts every item at the head within one cycle of runs', () => {
    const items = [1, 2, 3, 4];
    const heads = new Set([0, 1, 2, 3].map((r) => rotated(items, r)[0]));
    expect(heads).toEqual(new Set(items));
  });

  it('keeps every item exactly once, and an empty list empty', () => {
    expect(rotated([1, 2, 3], 7).sort()).toEqual([1, 2, 3]);
    expect(rotated([], 3)).toEqual([]);
  });
});

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
