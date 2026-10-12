/**
 * The batch runner classifies each driver's exit code against a
 * hand-maintained list, and a driver missing from it has its BLOCKED
 * reported as a product FAIL — "this drive found a defect" said about a
 * drive that did not complete. The row is not silent (the runner hedges
 * it as possibly infrastructure), but a hedged wrong verdict is still a
 * wrong verdict, and it asks the reader to discount a row rather than
 * giving them the right one.
 *
 * BLOCKED means the drive did not complete, NOT that it observed
 * nothing: a driver can pass every scenario for one role and then hit a
 * setup failure on the next, keeping those results and its report while
 * still exiting 2. Saying "verified nothing" of such a run erases work
 * somebody deliberately preserved, and sends the operator to re-review
 * surfaces that were checked (#2069 r13, restated here after this file
 * got it wrong on its first draft).
 *
 * The runner has warned about this at startup for a year. A warning was
 * not enough, and the reason is WHERE it printed: on a batch run, which
 * happens before a testnet release and not on a pull request. A driver
 * could be added, reviewed, merged and run for weeks in that state
 * (#2099). This file is the same question asked where somebody sees it
 * on the change that introduces it.
 *
 * NOT a mechanical gate, and the workflow says not to call it one:
 * `app-vitest.yml` is visible on every change and meant to be treated as
 * blocking by reviewers, but it is not among the required checks. What
 * this closes is nobody NOTICING; it does not stop a deliberate
 * override, and claiming otherwise would be the same kind of overstated
 * assurance this whole change is about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { statementFrom } from './sourceBlock.mjs';
import {
  batchDrivers,
  classifyExit,
  doublyDeclaredDrivers,
  driversOnDisk,
  FOUR_VERDICT_DRIVERS,
  MANUAL_ONLY_DRIVERS,
  THREE_VERDICT_DRIVERS,
  TWO_VERDICT_DRIVERS,
  undeclaredDrivers,
} from './verdictContract.mjs';

describe('#2099 — every live driver says which verdicts it speaks', () => {
  it('leaves no driver unclassified', () => {
    expect(
      undeclaredDrivers(),
      'a live driver is in none of THREE_VERDICT_DRIVERS, FOUR_VERDICT_DRIVERS or TWO_VERDICT_DRIVERS, ' +
        'so the batch will report its BLOCKED as a product FAIL. Read the driver: ' +
        'if it exits 2 for a failed precondition, register it in the first; if it ' +
        'deliberately does not, record it in the second WITH THE REASON',
    ).toEqual([]);
  });

  // The check has to be able to FAIL, and a check over a directory that
  // happens to be complete today proves nothing about that.
  it('names a driver that is in neither list', () => {
    expect(undeclaredDrivers(['live-alerts-link.mjs', 'live-nobody-classified.mjs'])).toEqual([
      'live-nobody-classified.mjs',
    ]);
  });

  it('accepts a driver declared two-verdict, not only a registered one', () => {
    // Both lists satisfy it, which is the distinction the single list
    // could not express: opting out is a decision, and is not the same
    // as nobody having got to it.
    expect(undeclaredDrivers([...THREE_VERDICT_DRIVERS])).toEqual([]);
    expect(undeclaredDrivers([...FOUR_VERDICT_DRIVERS.keys()])).toEqual([]);
    expect(undeclaredDrivers([...TWO_VERDICT_DRIVERS.keys()])).toEqual([]);
  });

  // Registering a driver that never agreed to mean BLOCKED by exiting 2
  // is the dishonesty the set exists to prevent, so the list is pinned
  // against what is actually on disk rather than only against itself.
  it('registers nothing that is not there', () => {
    const disk = new Set(driversOnDisk());
    const phantom = [...THREE_VERDICT_DRIVERS, ...FOUR_VERDICT_DRIVERS.keys(), ...TWO_VERDICT_DRIVERS.keys()].filter(
      (n) => !disk.has(n),
    );
    expect(phantom, 'a declared driver no longer exists on disk').toEqual([]);
  });

  // TWO declarations for one driver is worse than none: the runner
  // announces it as an opt-out and then classifies its exit 2 off the
  // other list, so its own two reporting sites disagree about one run.
  it('gives each driver exactly one contract', () => {
    expect(
      doublyDeclaredDrivers(),
      'a driver is in BOTH verdict lists — the usual way in is converting one ' +
        'and forgetting to remove the old entry. Remove it from whichever list ' +
        'no longer describes it',
    ).toEqual([]);
  });

  it('records a reason for every deliberate opt-out, and for every four-verdict driver', () => {
    const missing = [...TWO_VERDICT_DRIVERS, ...FOUR_VERDICT_DRIVERS].filter(([, why]) => !why || !String(why).trim());
    expect(missing.map(([n]) => n), 'an opt-out without a reason is an oversight wearing a decision').toEqual([]);
  });
});

// #2434 r2 — exit 3 = UNDETERMINED is a DECLARED fourth verdict, never an
// assumed one, and the runner's classification is this one tested function.
describe('classifyExit — the batch verdict for an exit code', () => {
  it('live-refinance is declared four-verdict, and in no other list', () => {
    expect(FOUR_VERDICT_DRIVERS.has('live-refinance.mjs')).toBe(true);
    expect(THREE_VERDICT_DRIVERS.has('live-refinance.mjs')).toBe(false);
    expect(TWO_VERDICT_DRIVERS.has('live-refinance.mjs')).toBe(false);
  });

  it('exit 3 is UNDETERMINED only from a declared four-verdict driver; FAIL from any other', () => {
    expect(classifyExit('live-refinance.mjs', 3)).toBe('UNDETERMINED');
    expect(classifyExit('live-alerts-link.mjs', 3)).toBe('FAIL');
    expect(classifyExit('live-nobody-classified.mjs', 3)).toBe('FAIL');
  });

  it('a four-verdict driver keeps the three-verdict meanings', () => {
    expect(classifyExit('live-refinance.mjs', 0)).toBe('PASS');
    expect(classifyExit('live-refinance.mjs', 1)).toBe('FAIL');
    expect(classifyExit('live-refinance.mjs', 2)).toBe('BLOCKED');
  });

  it('exit 2 is BLOCKED only from a contract driver; a crash or an invented code is FAIL', () => {
    expect(classifyExit('live-alerts-link.mjs', 2)).toBe('BLOCKED');
    expect(classifyExit('live-nobody-classified.mjs', 2)).toBe('FAIL');
    expect(classifyExit('live-alerts-link.mjs', null)).toBe('FAIL');
    expect(classifyExit('live-refinance.mjs', 4)).toBe('FAIL');
  });

  it('the batch runner classifies through classifyExit and nothing else', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const runner = fs.readFileSync(path.join(here, 'run-live-batch.mjs'), 'utf8');
    expect(statementFrom(runner, 'results.push({')).toContain('verdict: classifyExit(script, res.status),');
    expect(runner).not.toMatch(/res\.status === 2/);
  });
});

// Manual-only is a decision about whether the BATCH launches a driver, not
// a way out of declaring its verdicts — so each entry must still be a real,
// declared driver, carry its reason, and be the only thing the batch drops.
describe('manual-only drivers are skipped visibly, never undeclared', () => {
  it('names only drivers that exist on disk', () => {
    const disk = new Set(driversOnDisk());
    expect([...MANUAL_ONLY_DRIVERS.keys()].filter((n) => !disk.has(n))).toEqual([]);
  });

  it('still declares each one in exactly one verdict list', () => {
    for (const n of MANUAL_ONLY_DRIVERS.keys()) {
      expect(undeclaredDrivers([n]), `${n} is manual-only but declared nowhere`).toEqual([]);
      expect(doublyDeclaredDrivers(), `${n} is declared twice`).not.toContain(n);
    }
  });

  it('records a reason for every manual-only driver', () => {
    const missing = [...MANUAL_ONLY_DRIVERS].filter(([, why]) => !why || !String(why).trim());
    expect(missing.map(([n]) => n)).toEqual([]);
  });

  it('drops exactly the manual-only drivers from a batch, and nothing else', () => {
    const disk = driversOnDisk();
    const batch = batchDrivers(disk);
    expect(disk.filter((n) => !batch.includes(n)).sort()).toEqual(
      [...MANUAL_ONLY_DRIVERS.keys()].filter((n) => disk.includes(n)).sort(),
    );
    // And it can bite: a non-manual name passes straight through.
    expect(batchDrivers(['live-alerts-link.mjs', 'live-refinance.mjs'])).toEqual(['live-alerts-link.mjs']);
  });
});
