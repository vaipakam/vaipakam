/**
 * #2843 — a time a row reports as "not before": the verdict is judged
 * against the reader's clock, the time itself is what the source recorded,
 * and a zero time means only what its row says it means.
 */
import { describe, expect, it } from 'vitest';
import { CONSOLE_SECTIONS, readGraceSchedule, readNotBefore } from './protocolConsoleRows';

describe('readNotBefore', () => {
  const NOW = 1_800_000_000;

  it('reads zero as "none", never as a time in 1970', () => {
    expect(readNotBefore('0', NOW)).toEqual({ kind: 'none' });
  });

  it('says a time at or before now has passed, and keeps the time', () => {
    expect(readNotBefore(String(NOW), NOW)).toEqual({ kind: 'passed', at: NOW });
    expect(readNotBefore(String(NOW - 1), NOW)).toEqual({ kind: 'passed', at: NOW - 1 });
  });

  it('says how long until a time ahead of now', () => {
    expect(readNotBefore(String(NOW + 3_600), NOW)).toEqual({ kind: 'ahead', at: NOW + 3_600, inSec: 3_600 });
  });

  it('refuses a value that no date can carry, rather than inventing one', () => {
    for (const v of ['', '-1', '1.5', '0x10', 'abc', '9007199254740993', '8640000000001']) {
      expect(readNotBefore(v, NOW), v).toEqual({ kind: 'unreadable' });
    }
  });
});

describe('notBefore rows', () => {
  it('each state what a zero time means on that row', () => {
    const rows = CONSOLE_SECTIONS.flatMap((s) => s.rows).filter((r) => r.format === 'notBefore');
    expect(rows.map((r) => r.key)).toEqual(['autoPauseAvailableAt']);
    for (const r of rows) expect(r.zeroMeans, r.key).toBeDefined();
  });
});

/** #2680 — the grace schedule as a source published it. */
describe('readGraceSchedule', () => {
  it('reads the published rows, the catch-all included', () => {
    expect(
      readGraceSchedule([
        { maxDurationDays: '7', graceSeconds: '3600' },
        { maxDurationDays: '0', graceSeconds: '2592000' },
      ]),
    ).toEqual([
      { maxDurationDays: 7, graceSeconds: 3600 },
      { maxDurationDays: 0, graceSeconds: 2_592_000 },
    ]);
  });

  it('reads an empty list as unset, never as "no grace"', () => {
    expect(readGraceSchedule([])).toBe('unset');
  });

  it('reports anything else as unreadable rather than guess at it', () => {
    for (const v of [
      undefined,
      '7',
      [{ maxDurationDays: 7, graceSeconds: 3600 }],
      [{ maxDurationDays: '7' }],
      [{ maxDurationDays: '-1', graceSeconds: '3600' }],
      [{ maxDurationDays: '7', graceSeconds: '9007199254740993' }],
      [null],
    ]) {
      expect(readGraceSchedule(v), JSON.stringify(v)).toBeNull();
    }
  });
});
