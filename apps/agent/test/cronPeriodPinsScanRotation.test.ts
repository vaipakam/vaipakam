/**
 * The periodic lane's scan rotation has a precondition on the CRON PERIOD, and
 * this is what keeps it from being an accident (#2213 r8 follow-up).
 *
 * `periodicPreNotify` scans a window wider than one tick can cover by starting
 * successive ticks at successive spans: `start = (minute % spans) * SCAN_SPAN`.
 * The guarantee it claims — every candidate examined within `spans` ticks — is
 * true only when the tick period and the span count share no factor. At one
 * tick per minute the period is 1, which is coprime with everything, so the
 * claim holds for any window size.
 *
 * Change the schedule to every five minutes and it silently stops holding for
 * any window of 1,201–1,500 candidates (`spans` = 5): the minute is then
 * always a multiple of five, `minute % 5` is always zero, and span 0 is the
 * only part of the window ever scanned. Everything behind it is starved —
 * exactly the failure the rotation was added to fix, reintroduced by an edit
 * to a different file that mentions none of this.
 *
 * A comment in the lane cannot catch that; whoever edits the schedule is not
 * reading the lane. So the coupling is asserted where it can fail loudly.
 *
 * IF THE SCHEDULE MUST CHANGE: the rotation needs a driver that does not
 * inherit the period — a persisted tick counter, or a hashed minute (which
 * trades the deterministic bound for a probabilistic one). Do not simply
 * update the expectation here; that would make this file agree with a lane
 * that had quietly stopped covering its window.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));

/** The `crons` entries, read out of the JSONC without a parser. */
function crons(): string[] {
  const text = readFileSync(CONFIG, 'utf8')
    // Line comments only — the file has no block comments, and a naive block
    // strip would eat a `*/5` inside a cron string, which is the very value
    // this test exists to look at.
    .replace(/^\s*\/\/.*$/gm, '');
  const match = /"crons"\s*:\s*\[([^\]]*)\]/.exec(text);
  expect(match, 'wrangler.jsonc has no triggers.crons array').not.toBeNull();
  return [...match![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

describe('the agent cron period the scan rotation depends on', () => {
  it('fires every minute, so the rotation covers every span', () => {
    // One tick per minute means the rotation driver advances by exactly 1 each
    // tick. `(k + 1) % spans` walks every residue for any `spans`, which is
    // what makes "examined within `spans` ticks" a guarantee rather than a
    // hope.
    expect(crons()).toContain('* * * * *');
  });

  it('carries no coarser schedule that would alias with a span count', () => {
    // A second, coarser entry would mean some ticks advance the driver by more
    // than one — and a step sharing a factor with `spans` skips residues
    // permanently. Named individually so the failure says which entry is the
    // problem.
    for (const c of crons()) {
      const minuteField = c.trim().split(/\s+/)[0];
      expect(
        minuteField,
        `cron "${c}" does not fire every minute; see this file's header before ` +
          `changing it — the periodic pre-notify scan rotation assumes a ` +
          `tick period of 1`,
      ).toBe('*');
    }
  });
});
