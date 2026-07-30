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

/** Per-file counts, so one file's fix cannot mask another's regression. */
export function tally(findings) {
  const t = {};
  for (const f of findings) t[f.file] = (t[f.file] ?? 0) + 1;
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
  for (const [file, n] of Object.entries(counts)) {
    const was = baseline[file] ?? 0;
    if (n > was) regressions.push({ file, was, now: n });
  }
  for (const [file, was] of Object.entries(baseline)) {
    const now = counts[file] ?? 0;
    if (now < was) improvements.push({ file, was, now });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
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
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`${name}: baseline written — ${total} finding(s) across ${Object.keys(counts).length} file(s).`);
    return 0;
  }

  const baseline = loadBaseline(baselinePath);
  if (baseline === null) {
    console.error(`${name}: no baseline at ${baselinePath}. Run with --write-baseline.`);
    return 1;
  }

  const { regressions, improvements, total } = compare(counts, baseline);

  for (const f of findings) {
    if (regressions.some((r) => r.file === f.file)) {
      console.error(`${f.file}:${f.n}  ${f.tok ?? ''}`);
      if (f.line) console.error(`    ${f.line.trim()}`);
      console.error(`    -> ${f.why}\n`);
    }
  }

  if (improvements.length) {
    console.log(`${name}: ${improvements.length} file(s) improved — lower the baseline:`);
    for (const i of improvements) console.log(`    ${i.file}: ${i.was} -> ${i.now}`);
    console.log('    (a baseline above reality silently re-permits what was just fixed)\n');
  }

  if (regressions.length) {
    console.error(`${name}: ${regressions.length} file(s) GAINED findings:`);
    for (const r of regressions) console.error(`    ${r.file}: ${r.was} -> ${r.now}`);
    console.error(`\nTotal ${total}; the frozen backlog is tracked separately.`);
    return 1;
  }

  console.log(`${name}: no new findings (${total} known, frozen by baseline).`);
  return 0;
}
