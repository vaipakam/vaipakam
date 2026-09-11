/**
 * The confirm control's TRIAL CLICK is aimed at the confirm control —
 * asserted against the drive's own source.
 *
 * WHY A SOURCE TEST. Same reason as `exitOrdering.test.mjs`, and the
 * same caveat: `live-position-observe.mjs` is a top-level script that
 * runs the entire drive on import, so this branch cannot be executed
 * from a unit test. Extraction is tracked with the other one (#2120).
 *
 * WHAT IT PROTECTS. Round 46 added a trial click on the confirmation's
 * fee-paying button, addressed by the INDEX the in-page snapshot
 * recorded. The trial then re-queries the DOM. If the panel re-rendered
 * in between, `nth(i)` can land on BACK — which is always clickable —
 * and the drive would report a broken confirm control as usable. A false
 * PASS on the button that spends the lender's money is the precise
 * failure this whole probe exists to prevent, so the snapshot's label is
 * re-read and compared before the trial runs.
 *
 * The realistic regression is someone deleting the comparison as
 * redundant — the index is "obviously" still right — which restores the
 * hazard silently and leaves every other signal green. That is what
 * these three cases fail on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DRIVE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'live-position-observe.mjs',
);

describe('the trial click is aimed at the control it reported on', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');
  const at = (needle) => src.indexOf(needle);

  const TRIAL_GATE = 'if (confirmAction && confirmAction.index >= 0) {';
  /**
   * The trial CALL, searched from the gate rather than from the start of
   * the file. `trial: true` also appears in the comment ABOVE the gate
   * explaining what it does, so a bare `indexOf` returns the prose and
   * every slice taken between them is empty — an assertion that passes
   * by measuring nothing. Caught by this suite failing on its own first
   * run, which is the one way a source test of this shape gets caught at
   * all.
   */
  const trialCall = () => src.indexOf('trial: true', at(TRIAL_GATE));

  it('the branch this is written against still exists', () => {
    // Guards the guard: if the block is renamed, the slices below would
    // be taken from index -1 and assert nothing — the vacuous shape this
    // PR has already been caught by twice.
    expect(at(TRIAL_GATE), 'the trial-click branch was not found').toBeGreaterThan(-1);
    expect(trialCall(), 'the trial click itself was not found').toBeGreaterThan(at(TRIAL_GATE));
  });

  it('re-reads the label and compares it before trialling', () => {
    const block = src.slice(at(TRIAL_GATE), trialCall());
    expect(block.length, 'the slice must not be empty').toBeGreaterThan(0);
    expect(block).toContain('labelNow');
    expect(block).toContain('labelNow === confirmAction.label');
  });

  it('records the label in the snapshot the comparison reads', () => {
    // The comparison is only meaningful if the in-page pass captured
    // what to compare against. Dropping the field would make
    // `confirmAction.label` undefined, and `labelNow === undefined` is
    // false for every real button — which fails CLOSED (never trialled,
    // says nothing) rather than open, but silently switches the check
    // off, so it is pinned too.
    expect(src).toContain('label:');
    expect(src).toContain("(confirmButton.innerText ?? '').trim()");
  });

  it('leaves clickable unset on a mismatch rather than reporting false', () => {
    // "Was not tested" and "could not be clicked" are different
    // statements, and the verdict distinguishes them by `=== false`.
    // Collapsing the mismatch into false would invent an observed defect
    // out of a re-render.
    const block = src.slice(at(TRIAL_GATE), at(TRIAL_GATE) + 900);
    const assignments = [...block.matchAll(/confirmAction\.clickable\s*=/g)];
    expect(assignments).toHaveLength(1);
  });
});
