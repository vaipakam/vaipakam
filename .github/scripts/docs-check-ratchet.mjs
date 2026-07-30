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

  if (improvements.length) {
    console.log(`${name}: ${improvements.length} file(s) improved — lower the baseline:`);
    for (const i of improvements) {
      console.log(`    ${i.file}: ${i.gone.length} fixed (${i.gone.slice(0, 3).join(', ')}${i.gone.length > 3 ? ', …' : ''})`);
    }
    console.log('    (a baseline above reality silently re-permits what was just fixed)\n');
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
