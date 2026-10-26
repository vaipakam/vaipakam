import { describe, it, expect } from 'vitest';
import {
  EXTEND_WINDOW_SECONDS,
  extendWindowVerdict,
  type ExtendClock,
} from '../src/autoLifecycle';

const DAY = 86_400n;
const START = 1_800_000_000n;

/** The contract's default grace schedule (no governance buckets). */
const NO_PAUSE: ExtendClock = { pauseLog: [], graceBuckets: [] };

describe('auto-extend window (#2738)', () => {
  // A 30-day loan: due START + 30d, default grace for 30 days = 3 days.
  const loan = { startTime: START, durationDays: 30n };
  const due = START + 30n * DAY;

  it('is closed until three days before the due date', () => {
    expect(EXTEND_WINDOW_SECONDS).toBe(3n * DAY);
    // Day 2 of a 30-day loan: the re-term the issue reports, refused.
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, START + 2n * DAY)).toMatch(/^window opens at /);
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS - 1n)).toMatch(/^window opens at /);
  });

  it('is open from three days before the due date to the end of grace', () => {
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due + 3n * DAY)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, due + 3n * DAY + 1n)).toMatch(/^past grace/);
  });

  it('measures the window on the pause-adjusted due date', () => {
    // A two-day pause during the loan moves its due date two days later, so
    // the window that would have opened at due - 3d opens at due - 1d.
    const paused: ExtendClock = {
      pauseLog: [{ start: START + 5n * DAY, end: START + 7n * DAY, pausedBefore: 0n }],
      graceBuckets: [],
    };
    const now = due - 2n * DAY;
    expect(extendWindowVerdict(loan, 30n, NO_PAUSE, now)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, paused, now)).toMatch(/^window opens at /);
    expect(extendWindowVerdict(loan, 30n, paused, due - DAY)).toBeNull();
  });

  it('refuses a term that would make the loan defaultable sooner', () => {
    // A 365-day loan carries 30 days of grace. A 7-day term carries one day,
    // so even though its end moves later, its grace end lands earlier.
    const long = { startTime: START, durationDays: 365n };
    const longDue = START + 365n * DAY;
    const now = longDue - DAY;
    expect(extendWindowVerdict(long, 7n, NO_PAUSE, now)).toMatch(/defaultable sooner/);
    // A 30-day term from the start of the window lands exactly on the old
    // grace end (now + 30d + 3d = due - 3d + 33d), which is allowed.
    expect(extendWindowVerdict(long, 30n, NO_PAUSE, longDue - EXTEND_WINDOW_SECONDS)).toBeNull();
  });

  it('reads the grace length from the chain\'s buckets', () => {
    // Governance buckets: under 60 days get 10 days of grace, longer ones 1.
    const clock: ExtendClock = {
      pauseLog: [],
      graceBuckets: [
        { maxDurationDays: 60n, graceSeconds: 10n * DAY },
        { maxDurationDays: 0n, graceSeconds: DAY },
      ],
    };
    // Old grace end = due + 10d. A 30-day term from due - 1d ends due + 29d,
    // grace end due + 39d: allowed. The window still closes at due + 10d.
    expect(extendWindowVerdict(loan, 30n, clock, due - DAY)).toBeNull();
    expect(extendWindowVerdict(loan, 30n, clock, due + 10n * DAY + 1n)).toMatch(/^past grace/);
  });

  it('refuses a term that does not move the due date later', () => {
    // From three days before the due date, a 2-day term ends a day early.
    expect(extendWindowVerdict(loan, 2n, NO_PAUSE, due - EXTEND_WINDOW_SECONDS)).toMatch(/would not move the due date/);
  });
});
