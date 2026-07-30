/**
 * Shared ratchet for the docs checks.
 *
 * WHY A RATCHET RATHER THAN A THRESHOLD OF ZERO. Both docs checks are red
 * on their first run — 10 secrets-in-argv findings, 203 stale paths and
 * routes — because they are describing a real, already-tracked backlog
 * (#1462 for the path half). A check that is red on the day it lands gets
 * muted, and a muted check is worse than no check: it looks like coverage.
 *
 * Demanding the backlog be cleared first is also wrong for a specific
 * reason: some of it must NOT be cleared. `docs/ToDo.md`'s closed entries
 * and the design docs' historical references describe what was true when
 * written, and rewriting them falsifies the record — which is exactly why
 * #1462 is a scoped card and not a find-and-replace.
 *
 * So the bar is per-file and directional: a file may not gain findings, and
 * a clean file may not become dirty. The backlog is frozen where it is and
 * the class cannot grow. Clearing it lowers the baseline, which is a real
 * improvement someone can make deliberately.
 *
 * REGENERATE deliberately, never reflexively:
 *   node .github/scripts/<check>.mjs --write-baseline
 * A rise is the check working. Only lower a count you have actually fixed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The baseline as it exists on the BASE revision, not in this working tree.
 *
 * Without this the ratchet is self-defeating (#1467 r2, verified in review):
 * `--write-baseline` records whatever is currently found, and CI compares the
 * PR against the PR's OWN baseline — so adding an unsafe command and
 * committing a regenerated baseline in the same change reports no regression.
 * That is precisely the "silent baseline raise" the README forbids, and it
 * would have made the eventual gate bypassable by the one move it warns
 * against.
 *
 * @returns the base-revision baseline, or null when there is no base to
 *          compare against (a fresh clone, or the very first commit) — in
 *          which case the caller degrades to warning rather than pretending
 *          it verified something.
 */
function baseRevisionBaseline(path) {
  // The MERGE BASE with main, not HEAD^ — and the distinction matters. HEAD^
  // is this branch's own previous commit, so comparing against it would let a
  // two-commit PR raise the baseline in the first commit and pass in the
  // second, and it would flag a brand-new baseline as "grown" against a
  // format that never existed upstream. Both were live bugs in the first cut
  // of this function.
  // The base comes from the WORKFLOW EVENT when CI provides one, not from a
  // hardcoded `origin/main` (#1467 r3). Hardcoding was wrong in two live
  // cases: on a push to `main`, `origin/main` is already the pushed tip, so
  // the baseline was compared against ITSELF and a direct increase passed;
  // and on a PR targeting a branch other than main, differences inherited
  // from the parent were attributed to the child.
  //
  // `DOCS_CHECK_BASE_REF` is set by the workflow — `github.event.before` on
  // push, `origin/<base_ref>` on pull_request. Falling back to `origin/main`
  // keeps local runs working.
  const baseRef = process.env.DOCS_CHECK_BASE_REF || 'origin/main';
  let mergeBase;
  try {
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseRef], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // An explicit base that cannot be resolved is a CI misconfiguration, not
    // a missing base — say so rather than silently degrading to a warning.
    return { kind: process.env.DOCS_CHECK_BASE_REF ? 'bad-base-ref' : 'no-base' };
  }

  let raw;
  try {
    raw = execFileSync('git', ['show', `${mergeBase}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // The baseline does not exist upstream: this change INTRODUCES it. Every
    // entry is new by definition, so a growth check is meaningless — say so
    // rather than passing silently, because the initial baseline is a set of
    // permanent exemptions that nothing here has vetted.
    return { kind: 'introduced', mergeBase };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', mergeBase };
  }
  // A format change upstream (counts vs fingerprints) is not comparable, and
  // guessing would produce nonsense findings.
  const comparable = Object.values(parsed).every((v) => Array.isArray(v));
  if (!comparable) return { kind: 'incomparable', mergeBase };

  return { kind: 'ok', ref: mergeBase.slice(0, 8), baseline: parsed };
}

/**
 * Per-file FINGERPRINTS, not counts (#1467 r1).
 *
 * A count-only baseline permits a new defect whenever another finding in the
 * same file is fixed in the same change: swap one stale route for a different
 * stale route and `n === was`, so nothing is reported. It also banks reusable
 * headroom after any improvement whose baseline is not immediately lowered —
 * a later new finding can restore the old count and pass.
 *
 * The invariant is "no NEW instance lands", so identity is what has to be
 * compared. The fingerprint is the finding's `tok` (its stable subject: the
 * cited path, the `cmd:VARS` pair, `--value`) and deliberately NOT its line
 * number, so unrelated edits above it do not read as regressions.
 */
export function tally(findings) {
  const t = {};
  const seen = {};
  for (const f of findings) {
    const subject = f.tok ?? f.why;
    // ORDINAL-suffixed, so repeat occurrences of one subject stay countable.
    // De-duplicating by subject alone looked tidier and quietly weakened the
    // bar: with `cast:PRIVATE_KEY` already twice in a file, a third would add
    // no new fingerprint and pass. The ordinal restores occurrence
    // sensitivity while staying immune to line-number churn from edits
    // above.
    const key = `${f.file}\u0000${subject}`;
    seen[key] = (seen[key] ?? 0) + 1;
    (t[f.file] ??= []).push(`${subject}#${seen[key]}`);
  }
  for (const k of Object.keys(t)) t[k] = t[k].sort();
  return t;
}

export function loadBaseline(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeBaseline(path, counts) {
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * @returns {{regressions: Array, improvements: Array, total: number}}
 */
export function compare(counts, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [file, fps] of Object.entries(counts)) {
    const was = new Set(baseline[file] ?? []);
    const added = fps.filter((fp) => !was.has(fp));
    if (added.length) regressions.push({ file, added });
  }
  for (const [file, was] of Object.entries(baseline)) {
    const now = new Set(counts[file] ?? []);
    const gone = was.filter((fp) => !now.has(fp));
    if (gone.length) improvements.push({ file, gone });
  }
  const total = Object.values(counts).reduce((a, b) => a + b.length, 0);
  return { regressions, improvements, total };
}

/**
 * Print the verdict and return the exit code.
 *
 * Improvements are reported too, and loudly: a stale baseline that is
 * higher than reality silently re-permits the findings someone just fixed.
 */
export function report(name, findings, baselinePath, { write } = {}) {
  const counts = tally(findings);

  if (write) {
    writeBaseline(baselinePath, counts);
    const total = Object.values(counts).reduce((a, b) => a + b.length, 0);
    console.log(`${name}: baseline written — ${total} finding(s) across ${Object.keys(counts).length} file(s).`);
    return 0;
  }

  const baseline = loadBaseline(baselinePath);
  if (baseline === null) {
    console.error(`${name}: no baseline at ${baselinePath}. Run with --write-baseline.`);
    return 1;
  }

  const { regressions, improvements, total } = compare(counts, baseline);

  // ── the baseline itself must not have GROWN (#1467 r2) ────────────────
  //
  // Checked before anything else, because a raised baseline makes every
  // check below vacuous: the findings it would have caught are now
  // "known".
  const base = baseRevisionBaseline(baselinePath);
  if (base.kind === 'introduced') {
    console.warn(
      `${name}: this change INTRODUCES the baseline (${Object.values(baseline).reduce((a, b) => a + b.length, 0)} entries). ` +
        'Each entry is a permanent exemption that no automated check has vetted — ' +
        'they need a human read.',
    );
  } else if (base.kind === 'bad-base-ref') {
    // An EXPLICIT base ref that will not resolve is a CI misconfiguration,
    // not an absent base (#1467 r4). Warning and exiting 0 meant the guard
    // silently stopped guarding whenever the event SHA had not been
    // fetched — reproduced in review with a bogus ref — so the eventual
    // gate could be bypassed by breaking the check rather than passing it.
    console.error(
      `${name}: DOCS_CHECK_BASE_REF="${process.env.DOCS_CHECK_BASE_REF}" cannot be ` +
        'resolved. Baseline growth cannot be verified, and a check that cannot ' +
        'verify must not report success. Ensure the workflow fetches enough ' +
        'history (fetch-depth: 0) and passes a ref that exists.',
    );
    return 1;
  } else if (base.kind !== 'ok') {
    console.warn(
      `${name}: cannot compare the baseline against its base revision (${base.kind}) — ` +
        'baseline growth is NOT verified in this run.',
    );
  } else {
    // RENAMES first (#1467 r4). A document renamed without content changes
    // re-keys every one of its fingerprints under the new filename, and each
    // then looks like a forbidden baseline addition — reproduced in review.
    // Punishing a rename would push people to avoid the check rather than the
    // defect. Git already knows; ask it.
    const renames = new Map();
    try {
      const out = execFileSync(
        'git',
        ['diff', '--name-status', '--find-renames', `${base.ref}`, 'HEAD'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of out.split('\n')) {
        const m = line.match(/^R\d*\t(.+)\t(.+)$/);
        if (m) renames.set(m[2], m[1]); // new path -> old path
      }
    } catch {
      /* rename detection is best-effort; fall through to strict comparison */
    }

    const added = [];
    for (const [file, fps] of Object.entries(baseline)) {
      const oldName = renames.get(file);
      const was = new Set(base.baseline[file] ?? base.baseline[oldName] ?? []);
      for (const fp of fps) if (!was.has(fp)) added.push(`${file}: ${fp}`);
    }
    if (added.length) {
      console.error(
        `${name}: the BASELINE gained ${added.length} entr(y|ies) versus ${base.ref}:`,
      );
      for (const a of added) console.error(`    ${a}`);
      console.error(
        '\nA baseline entry is a permanent exemption. Adding one silences a ' +
          'finding instead of fixing it, and makes every check below vacuous. ' +
          'Fix the finding, or — if the exemption is genuinely correct — say so ' +
          'explicitly in the PR so a human agrees to it.',
      );
      return 1;
    }
  }

  // ── obsolete entries must be cleaned up (#1467 r2) ────────────────────
  //
  // Reporting an improvement and returning success banks headroom: the
  // stale entry stays, and a later change can reintroduce that exact
  // fingerprint and match it. Failing here forces the regeneration that
  // makes the improvement permanent.
  const obsolete = improvements.flatMap((i) => i.gone.map((g) => `${i.file}: ${g}`));
  if (obsolete.length) {
    console.error(`${name}: ${obsolete.length} baseline entr(y|ies) no longer occur:`);
    for (const o of obsolete) console.error(`    ${o}`);
    console.error(
      '\nThese were FIXED — thank you — but the baseline still lists them, so ' +
        'the same finding could be reintroduced and match. Run with ' +
        '`--write-baseline` and commit, which makes the fix permanent.',
    );
    return 1;
  }

  const addedByFile = new Map(regressions.map((r) => [r.file, new Set(r.added)]));
  const printSeen = {};
  for (const f of findings) {
    const subject = f.tok ?? f.why;
    const key = `${f.file}\u0000${subject}`;
    printSeen[key] = (printSeen[key] ?? 0) + 1;
    if (addedByFile.get(f.file)?.has(`${subject}#${printSeen[key]}`)) {
      console.error(`${f.file}:${f.n}  ${f.tok ?? ''}`);
      if (f.line) console.error(`    ${f.line.trim()}`);
      console.error(`    -> ${f.why}\n`);
    }
  }

  if (regressions.length) {
    console.error(`${name}: ${regressions.length} file(s) gained NEW findings:`);
    for (const r of regressions) {
      console.error(`    ${r.file}: ${r.added.join(', ')}`);
    }
    console.error(`\nTotal ${total}; the frozen backlog is tracked separately.`);
    console.error(
      'Identity-based, so swapping one known finding for a different new one ' +
        'is still a regression — a count-only bar permitted exactly that.',
    );
    return 1;
  }

  console.log(`${name}: no new findings (${total} known, frozen by baseline).`);
  return 0;
}
