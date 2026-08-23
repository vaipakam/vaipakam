/**
 * The pass schedule (#1896).
 *
 * Two properties matter here, and only one of them is arithmetic.
 *
 * The first is that the stagger actually reduces per-tick work — the
 * whole point of the card. Asserting a cadence constant equals 5 would
 * pass against a table nobody dispatches on, so the test counts what a
 * real hour of ticks would DISPATCH and compares it to the ten-every-
 * minute baseline this replaces.
 *
 * The second is that a skip is never silent. A pass idle because it is
 * not due and a pass idle because it is wedged must be distinguishable
 * in `wrangler tail`, which is the property `passGate.test.ts`
 * established for arming (#1475) and the reason that file asserts
 * emitted text rather than return values.
 */
import { describe, expect, it } from 'vitest';
import {
  KEEPER_PASSES,
  cadenceSkipReason,
  DAILY_SNAPSHOT_HOUR_UTC,
  DAILY_SNAPSHOT_WINDOW_MINUTES,
} from '../src/passSchedule';
import { isTickDue, isWithinUtcMinuteWindow } from '@vaipakam/lib/cronCadence';

/** Epoch for a given UTC hour:minute on a fixed day. */
function tick(hour: number, minute: number): number {
  return Date.UTC(2026, 7, 23, hour, minute, 0, 0);
}

/** How many passes an hour of every-minute ticks would actually run. */
function dispatchesPerHour(): number {
  let n = 0;
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 1) {
      for (const p of KEEPER_PASSES) {
        if (cadenceSkipReason(p, tick(h, m)) === null) n += 1;
      }
    }
  }
  return n;
}

describe('cadence arithmetic', () => {
  it('a cadence of 1 runs on every minute of the hour', () => {
    for (let m = 0; m < 60; m += 1) {
      expect(isTickDue(tick(3, m), 1)).toBe(true);
    }
  });

  it('a cadence of 5 runs 12 times an hour, on the multiples', () => {
    const due = [...Array(60).keys()].filter((m) => isTickDue(tick(3, m), 5));
    expect(due).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('uses the SCHEDULED minute, so a late delivery cannot skip a slot', () => {
    // A tick scheduled for :05 but delivered at :06 must still count as
    // :05 — reading `Date.now()` here is the bug this guards.
    expect(isTickDue(tick(3, 5), 5)).toBe(true);
    expect(isTickDue(tick(3, 6), 5)).toBe(false);
  });

  it('FAILS OPEN when the scheduled time is missing or unusable', () => {
    // A doubled tick is idempotent and wasteful; a never-running tick is
    // an outage. Every unusable input must run.
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isTickDue(bad as number | undefined, 5)).toBe(true);
      expect(isWithinUtcMinuteWindow(bad as number | undefined, 0, 10)).toBe(true);
    }
  });

  it('opens the daily window only inside it', () => {
    expect(
      isWithinUtcMinuteWindow(
        tick(DAILY_SNAPSHOT_HOUR_UTC, 0),
        DAILY_SNAPSHOT_HOUR_UTC,
        DAILY_SNAPSHOT_WINDOW_MINUTES,
      ),
    ).toBe(true);
    expect(
      isWithinUtcMinuteWindow(
        tick(DAILY_SNAPSHOT_HOUR_UTC, DAILY_SNAPSHOT_WINDOW_MINUTES),
        DAILY_SNAPSHOT_HOUR_UTC,
        DAILY_SNAPSHOT_WINDOW_MINUTES,
      ),
    ).toBe(false);
    expect(
      isWithinUtcMinuteWindow(tick(13, 30), DAILY_SNAPSHOT_HOUR_UTC, DAILY_SNAPSHOT_WINDOW_MINUTES),
    ).toBe(false);
  });
});

describe('the stagger reduces real dispatched work', () => {
  it('dispatches materially fewer passes per day than ten-every-minute', () => {
    const baseline = KEEPER_PASSES.length * 60 * 24; // the behaviour this replaces
    const actual = dispatchesPerHour();
    expect(actual).toBeLessThan(baseline);
    // Not a tight pin — the point is the order of the reduction, and a
    // tight number would break on any future cadence retune without
    // telling anyone anything useful.
    expect(actual).toBeLessThan(baseline * 0.6);
  });

  it('BOUNDS THE PEAK TICK — the number the CPU limit actually charges', () => {
    // The load-bearing assertion of this whole change. A Worker's CPU
    // limit is per invocation, so the busiest minute is what matters and
    // the daily total is a distraction. The first version of the table
    // used bare modulo cadences, which all coincide at :00 — it cut
    // daily dispatches by 63% while leaving the peak tick at nine
    // passes, i.e. it would not have fixed the bug at all. This is the
    // test that caught that, so it must stay pinned to the peak.
    let worst = 0;
    let worstAt = '';
    for (let h = 0; h < 24; h += 1) {
      for (let m = 0; m < 60; m += 1) {
        const n = KEEPER_PASSES.filter(
          (p) => cadenceSkipReason(p, tick(h, m)) === null,
        ).length;
        if (n > worst) {
          worst = n;
          worstAt = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
      }
    }
    // Three always-on passes, plus at most one staggered pass, plus the
    // daily-window pass during its ten minutes.
    expect(worst, `busiest tick was ${worstAt} with ${worst} passes`).toBeLessThanOrEqual(5);
  });

  it('no two staggered passes share a minute', () => {
    const staggered = KEEPER_PASSES.filter(
      (p) => p.cadenceMinutes > 1 && p.dailyWindow !== true,
    );
    for (let m = 0; m < 60; m += 1) {
      const due = staggered.filter((p) => cadenceSkipReason(p, tick(6, m)) === null);
      expect(
        due.map((p) => p.name),
        `minute :${String(m).padStart(2, '0')} has more than one staggered pass`,
      ).toHaveLength(due.length > 0 ? 1 : 0);
    }
  });

  it('never skips the three latency-sensitive passes', () => {
    // watcher and liquidator are protocol-safety functions; matcher is
    // the one users feel. If a future edit slows one of these, it should
    // be a deliberate decision with a profile behind it, not a silent
    // consequence of editing a table.
    for (const name of ['watcher', 'liquidator', 'matcher']) {
      const pass = KEEPER_PASSES.find((p) => p.name === name);
      expect(pass, `${name} missing from the table`).toBeDefined();
      for (let m = 0; m < 60; m += 1) {
        expect(cadenceSkipReason(pass!, tick(7, m)), `${name} at :${m}`).toBeNull();
      }
    }
  });

  it('still reaches every pass over an hour — nothing is stranded', () => {
    const reached = new Set<string>();
    for (let h = 0; h < 24; h += 1) {
      for (let m = 0; m < 60; m += 1) {
        for (const p of KEEPER_PASSES) {
          if (cadenceSkipReason(p, tick(h, m)) === null) reached.add(p.name);
        }
      }
    }
    expect([...reached].sort()).toEqual(KEEPER_PASSES.map((p) => p.name).sort());
  });
});

describe('a skip is never silent', () => {
  it('gives a reason naming the cadence and why it was chosen', () => {
    const remitAck = KEEPER_PASSES.find((p) => p.name === 'remitAck')!;
    const reason = cadenceSkipReason(remitAck, tick(3, 1));
    expect(reason).not.toBeNull();
    expect(reason).toContain('cadence');
    // The rationale travels with the skip, so an operator reading the
    // log does not have to open the source to learn why a pass is idle.
    expect(reason).toContain(remitAck.why);
  });

  it('names the window, not just "skipped", for the daily pass', () => {
    const daily = KEEPER_PASSES.find((p) => p.name === 'dailyOracleSnapshot')!;
    const reason = cadenceSkipReason(daily, tick(13, 30));
    expect(reason).not.toBeNull();
    expect(reason).toContain('UTC window');
  });

  it('every pass carries a non-empty rationale', () => {
    for (const p of KEEPER_PASSES) {
      expect(p.why.trim().length, `${p.name} has no rationale`).toBeGreaterThan(0);
    }
  });
});
