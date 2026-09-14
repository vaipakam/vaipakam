/**
 * The batch runner classifies each driver's exit code against a
 * hand-maintained list, and a driver missing from it has its BLOCKED
 * reported as a product FAIL — "this drive found a defect" said about a
 * drive that did not complete. The operator reading that row cannot
 * tell, and goes looking for a bug the list invented.
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
 * (#2099). This file is the same question asked where it fails.
 */
import { describe, expect, it } from 'vitest';

import {
  doublyDeclaredDrivers,
  driversOnDisk,
  THREE_VERDICT_DRIVERS,
  TWO_VERDICT_DRIVERS,
  undeclaredDrivers,
} from './verdictContract.mjs';

describe('#2099 — every live driver says which verdicts it speaks', () => {
  it('leaves no driver unclassified', () => {
    expect(
      undeclaredDrivers(),
      'a live driver is in neither THREE_VERDICT_DRIVERS nor TWO_VERDICT_DRIVERS, ' +
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
    expect(undeclaredDrivers([...TWO_VERDICT_DRIVERS.keys()])).toEqual([]);
  });

  // Registering a driver that never agreed to mean BLOCKED by exiting 2
  // is the dishonesty the set exists to prevent, so the list is pinned
  // against what is actually on disk rather than only against itself.
  it('registers nothing that is not there', () => {
    const disk = new Set(driversOnDisk());
    const phantom = [...THREE_VERDICT_DRIVERS, ...TWO_VERDICT_DRIVERS.keys()].filter(
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

  it('records a reason for every deliberate opt-out', () => {
    const missing = [...TWO_VERDICT_DRIVERS].filter(([, why]) => !why || !String(why).trim());
    expect(missing.map(([n]) => n), 'an opt-out without a reason is an oversight wearing a decision').toEqual([]);
  });
});
