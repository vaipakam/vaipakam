/**
 * The confirm control's TRIAL CLICK — aimed at the control it reported
 * on, and RECORDED on every path. Asserted against the drive's own
 * source.
 *
 * WHY A SOURCE TEST. Same reason as `exitOrdering.test.mjs`, and the
 * same caveat: `live-position-observe.mjs` is a top-level script that
 * runs the entire drive on import, so this branch cannot be executed
 * from a unit test. Extraction is tracked with the other one (#2120).
 *
 * TWO PROPERTIES, and they were added one round apart because the first
 * created the need for the second.
 *
 * 1. AIMED. `confirmAction.index` comes from the in-page snapshot and
 *    the trial re-queries the DOM. A re-render in between can leave
 *    `nth(i)` on BACK — which is always clickable — so a broken confirm
 *    control would be reported as usable: a false PASS on the button
 *    that spends the lender's money. The snapshot's label is re-read and
 *    compared before the trial runs.
 *
 * 2. RECORDED. Declining to trial then left `clickable` unset, which the
 *    verdict could not tell from a record predating the field — so the
 *    run passed without ever establishing the action was usable (round
 *    47 P2). The drive now writes `true` / `false` / `null` on every
 *    path, and the verdict blocks on `null`. That only holds while the
 *    assignment is unconditional, which is what the last case here is
 *    for: a field written at some exits and not others is exactly how
 *    `visibleSubmits` went missing twice on this PR.
 *
 * The realistic regression for (1) is deleting the comparison as
 * redundant — the index is "obviously" still right — and for (2) is
 * restoring the `if` around the assignment as a tidy-up. Both restore
 * the hazard silently, with every other signal green.
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

  /** The branch that owns the whole trial, whatever it decides. */
  const TRIAL_GATE = 'if (confirmAction) {';
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
  /** The whole branch, generously bounded — it is ~30 lines. */
  const branch = () => src.slice(at(TRIAL_GATE), at(TRIAL_GATE) + 1600);

  it('the branch this is written against still exists', () => {
    // Guards the guard. If the block is renamed, the slices below are
    // taken from index -1 and assert nothing — the vacuous-loop shape
    // this PR has already been caught by three times.
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
    // and since round 47 that is BLOCKED rather than a pass) but still
    // switches the check off silently, so it is pinned too.
    expect(src).toContain('label:');
    expect(src).toContain("(confirmButton.innerText ?? '').trim()");
  });

  it('writes the outcome on every path, never leaving it unset', () => {
    // ROUND 47 P2, and the property the whole tri-state rests on.
    // `undefined` must keep meaning "a record predating this field", so
    // the current run must never produce it — otherwise the verdict's
    // leniency for old records silently covers a live gap. Two
    // assignments: the trial's own result, and the `null` for the paths
    // that decline to trial.
    const block = branch();
    const assignments = [...block.matchAll(/confirmAction\.clickable\s*=/g)];
    expect(assignments.length, 'the outcome must be assigned on both paths').toBe(2);
    expect(block).toContain('= null;');
  });

  it('distinguishes untested from unclickable rather than collapsing them', () => {
    // The trial's own failure is `false`; declining to trial is `null`.
    // Collapsing the second into the first would invent an observed
    // defect out of a re-render, which is the opposite error and the one
    // this file guards against everywhere else.
    const block = branch();
    expect(block).toContain('.catch(() => false)');
    expect(block).toContain(': null');
  });
});

describe('the confirmation cluster counts only what is shown', () => {
  // ROUND 51 P2, and the one finding on this PR that pointed the other
  // way: not "a real defect went unreported" but "a CORRECT card would
  // have been reported as defective".
  //
  // Round 46 added the duplicate-action count with a raw
  // `querySelectorAll('button')`, so one usable action beside a button
  // hidden by CSS — responsive variants of the same control rendered
  // together being the ordinary way that happens — counted 2 and
  // produced "the lender is given more than one way to pay for it".
  //
  // The card's own duplicate rule has counted VISIBLE controls since
  // round 19, for the stated reason that a duplicate hidden in the DOM
  // is not something the lender is being shown. This is that rule one
  // level in, and it did not carry the filter.
  //
  // A source test because the cluster logic runs inside `page.evaluate`
  // and cannot be imported; extraction is #2120, as for the cases above.
  const src = fs.readFileSync(DRIVE, 'utf8');
  const at = (needle) => src.indexOf(needle);

  // AMENDED AFTER ROUND 56's self-review, and the guard did its job:
  // this case failed the moment the shape changed, which is the whole
  // reason it exists.
  //
  // The filter moved rather than went away. Computing `present` from the
  // FILTERED set had made the `visible` field dead — it could only ever
  // be true when `present` was — so a confirm button rendered but hidden
  // reported "no confirmation action was rendered beside Back": a true
  // verdict reached through a false sentence. The unfiltered set now
  // answers "was one rendered", and the filtered one answers everything
  // round 51's fix was actually about: the count, and which control is
  // judged and trialled.
  it('filters the cluster by the drive’s own visibility predicate', () => {
    expect(src).toContain('const clusterActions = allActions.filter(visible);');
  });

  it('answers PRESENT from the unfiltered set, so hidden is not absent', () => {
    expect(src).toContain('present: allActions.length > 0,');
  });

  it('selects the action from the FILTERED set', () => {
    // Otherwise a hidden first variant could be the control put through
    // the trial click — judging and trialling something the lender
    // cannot reach, which is the fix defeating itself.
    const i = at('const clusterActions =');
    expect(i, 'the cluster is no longer built here').toBeGreaterThan(-1);
    expect(src.slice(i, i + 600)).toContain('const confirmButton = clusterActions[0];');
  });

  it('still indexes over the card’s WHOLE button list', () => {
    // Deliberately NOT filtered: the Playwright side addresses
    // `card.locator('button').nth(index)`, which counts hidden buttons
    // too. Filtering here would have broken the aim of the trial while
    // fixing the count.
    expect(src).toContain("[...el.querySelectorAll('button')].indexOf(confirmButton)");
  });
});

describe('a reading that did not happen is never reported as an absence', () => {
  // SAME INVARIANT as the file above it, one level up: an outcome must
  // be recorded on every path, and the paths that establish nothing must
  // say so rather than defaulting into a finding.
  //
  // FOUND BY SELF-REVIEW of round 60's own fix, before Codex saw it.
  // Giving the mount wait a `waitForFunction` gave it a second way to
  // reject — `new Function` refusing a malformed extraction, or the
  // execution context being destroyed by a navigation mid-poll — and the
  // `.catch(() => false)` it inherited reads every rejection as "no card
  // was ever visible". That turns an infrastructure failure into a
  // missing-card FAIL on a healthy loan.
  //
  // It is round 41's defect at round 41's own call site: the comment
  // warning that a swallowed engine throw once stood in for `mounted:
  // false` is still directly above the line that re-introduced it.
  const src = fs.readFileSync(DRIVE, 'utf8');
  const at = (needle) => src.indexOf(needle);

  it('tells a timeout apart from a failure to ask the question', () => {
    // A timeout means the predicate ran and kept saying no, which IS an
    // absence. Anything else means it never ran. Collapsing the two is
    // the defect, so the discrimination is pinned.
    expect(src).toContain("if (err?.name !== 'TimeoutError') mountFault = err;");
  });

  it('reports a non-timeout fault as INCOMPLETE, not as a missing card', () => {
    const i = at('if (mountFault) {');
    expect(i, 'the mount-fault exit was not found').toBeGreaterThan(-1);
    const branch = src.slice(i, i + 400);
    expect(branch).toContain('nothingEstablished(');
    expect(branch).toContain('scrapeFailed: true');
  });

  it('names WHICH failure happened rather than leaving it to be guessed', () => {
    // This file's own rule, stated at the mount gate since round 3: a
    // hidden card and an absent one are different defects and a reader
    // should not have to guess. A failed scrape and a failed wait are
    // two more.
    expect(src).toContain('mountFault: String(mountFault?.message ?? mountFault)');
  });

  it('refuses an unbalanced extraction at import instead of at the first poll', () => {
    // Without this the brace walk can run off the end of the file and
    // return everything from the helper to EOF — source `new Function`
    // rejects on the first poll, inside the very `catch` above. Failing
    // at import, by name, is the difference between a named error and a
    // silent false absence.
    const i = at("const block = (name) => {");
    expect(i, 'the extractor was not found').toBeGreaterThan(-1);
    expect(src.slice(i, i + 1600)).toContain('if (depth !== 0) {');
  });

  it('builds the nothing-established shape in exactly ONE place', () => {
    // Four hand-written copies of the same fourteen-field literal is how
    // `visibleSubmits` went missing: one of the four simply omitted it,
    // and every other signal stayed green. Counted as calls minus the
    // declaration, the same way the head-sample count is — measuring the
    // definition instead of the call sites is a mistake this suite has
    // already made once.
    //
    // FIVE sites, not four, and this case failed on its first run by
    // asserting four — the count I had in mind was of the literals this
    // replaced, and the mount-fault exit above is a new fifth. Left
    // recorded because it is the same error the case is written against:
    // a number taken from memory rather than from the code.
    const all = [...src.matchAll(/nothingEstablished\(/g)];
    const declarations = [...src.matchAll(/function nothingEstablished\(/g)];
    expect(declarations, 'exactly one definition').toHaveLength(1);
    expect(all.length - declarations.length, 'every site goes through it').toBe(5);
  });

  it('keeps `bodyPresent` undefined there, which is what the verdict reads', () => {
    // The whole shape rests on this one field: `undefined` is "nothing
    // was observed", and any value at all would make it a finding.
    const i = at('function nothingEstablished(');
    expect(src.slice(i, i + 700)).toContain('bodyPresent: undefined,');
  });
});
