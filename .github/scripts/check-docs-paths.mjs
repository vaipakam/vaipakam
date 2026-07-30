#!/usr/bin/env node
/**
 * Docs gate: no operator runbook cites a directory that no longer exists.
 *
 * WHY THIS EXISTS. The Stage 3 refactor moved the dApp to `apps/defi`, but 147
 * references to the removed `frontend/` directory survived across 39 documents
 * (#1462). An operator following one looks for a file that is not there, at
 * exactly the moment they can least afford to. Nothing tells the author of a
 * rename which prose mentions the old name, so the class is not preventable by
 * discipline — a code class can be closed with a type; a prose class can only
 * be closed by re-checking.
 *
 * ── THE ADMISSION CRITERION ───────────────────────────────────────────────
 *
 * This file adjudicates; `docs-citations.mjs` extracts, and its extractor is
 * deliberately loose — it will offer fragments that are not citations at all.
 *
 *     A rule may ship here ONLY IF its finding is a real defect of the
 *     DOCUMENT TEXT even when the fragment it fired on is malformed.
 *
 * That criterion is the architecture, and twelve rounds of review on #1467 is
 * what it cost to state correctly. (Round 12 falsified an earlier, stronger
 * wording — "over-extraction cannot make the rule fire". It can: a malformed
 * non-link like `[x](frontend/ghost"title")` extracts a fragment that starts
 * with the dead name, and the gate fires. But what it fired on is operator-doc
 * text that NAMES the removed directory, which is the defect itself — the
 * finding stays truthful. Immunity to over-extraction holds only for exact
 * equality; truthfulness under over-extraction is the property that survives,
 * and it is the one that matters.) Rules come in two shapes:
 *
 *   - CLOSED-WORLD POSITIVE — "does this fragment contain one of these two
 *     known-dead names?" Whatever junk surrounds it, a hit means the text
 *     really does name the dead directory. Extractor defects can only cause
 *     MISSES or oddly-delimited findings, never a finding about nothing.
 *
 *   - OPEN-WORLD NEGATIVE — "is this fragment absent from the tree?" Every junk
 *     fragment is absent, so it fires on all of them, and each such finding is
 *     about NOTHING. Such a rule amplifies every extractor defect into a false
 *     alarm, and can be no more correct than its extractor.
 *
 * `REMOVED_DIRS` below is the first shape, and the review record bears the
 * distinction out exactly: all six extraction findings on this branch became
 * false alarms ONLY through an open-world rule, and five of seven adjudication
 * findings landed on one too.
 *
 * Three open-world rules were built on this branch and deferred, each needing a
 * precise extractor — which means a real parser, not more patches to a loose
 * one:
 *
 *   - does-it-exist against the tracked tree ...................... #1486
 *   - non-canonical `/app/…` URL citations ........................ #1479
 *   - secrets reaching a command's argv ........................... #1472
 *
 * Each was deferred separately, on its own judgement call, before anyone
 * noticed they fail the same test. That they fall out of one criterion is the
 * evidence the criterion is real rather than a rationalisation.
 *
 * ── WHY THIS GATES AT ZERO, WITH NO BASELINE ──────────────────────────────
 *
 * Earlier revisions carried a ratchet: a committed baseline of finding
 * identities, a growth guard, rename detection, fingerprints. Every part of it
 * existed for one reason — the check was red on arrival and the backlog was
 * assumed unclearable.
 *
 * The platform is PRE-LIVE, which makes that assumption false where it counts.
 * The operator-facing slice was 72 citations across 6 runbooks with knowable
 * targets, so it was FIXED rather than frozen. With the gated scope clean, the
 * baseline, the ratchet and its follow-up card are all unnecessary: this gates
 * at zero from its first run.
 *
 * SCOPE IS `docs/ops/` ON PURPOSE. That is where a stale path costs a person
 * real time, and it is the slice that has actually been cleaned. The wider doc
 * set still holds ~137 stale citations in design docs and closed to-do entries;
 * widening this scope is the completion criterion of #1462, not a thing to do
 * by loosening the gate.
 *
 * WHAT IT CANNOT SEE: a path that exists but is the WRONG one, a stale name in
 * a citation form the loose extractor misses, and any reference outside a code
 * span or a link. It closes one class completely rather than many partly.
 */

import { dirname, posix } from 'node:path';
import { citations, scopedDocs, trackedFiles } from './docs-citations.mjs';

/** Documents the gate covers. See "SCOPE IS `docs/ops/`" above. */
const GATED = ['docs/ops/'];

/**
 * Directories that were REMOVED or renamed. A citation of one is wrong wherever
 * it appears, with no judgement needed — which is what makes the rule immune to
 * the extractor's looseness, and exactly the #1462 class.
 *
 * Adding an entry is the one manual step, and it is the right one: the person
 * doing the rename is the only one who knows it happened.
 *
 * **Run `git ls-files <dir>` before adding one.** `ops/lz-watcher/` was listed
 * here while still fully tracked — 16 files, its decommission recorded as
 * deferred in `AdminKeysAndPause.md` — which made two live citations read as
 * nonexistent (#1467 r5). The check asserting a fact the tree contradicts is
 * the one failure this rule can still have, and it is a human one.
 */
const REMOVED_DIRS = [
  ['frontend/', 'the dApp moved to `apps/defi/`, and its contract bundle to `packages/contracts/`, in the Stage 3 refactor'],
  ['ops/hf-watcher/', 'split into `apps/{keeper,indexer,agent}` (Stage 3)'],
];

const TRACKED = new Set(trackedFiles());

/**
 * Does this fragment name a removed directory?
 *
 * Matches the slash-terminated prefix OR the bare name — a backticked
 * `frontend` is the same stale name and the commonest prose form of it
 * (#1467 r5).
 *
 * The tracked tree is consulted in exactly one direction: to ACQUIT. A
 * fragment that resolves to a tracked file is correct whatever it is called, so
 * a live `docs/ops/frontend/guide.md` is never reported (#1467 r6). Resolution
 * is tried in every way the fragment could legitimately be read — as written,
 * with relative prefixes stripped, and RELATIVE TO THE CITING DOCUMENT, since
 * that is how a markdown destination actually renders (#1467 r12: a tracked
 * `docs/ops/frontend/guide.md` linked as `frontend/guide.md` was reported
 * because only the raw token was probed). Using the tree to ACCUSE would be the
 * open-world rule the admission criterion excludes, and is what #1486 carries.
 */
const removedDirHit = (tok, file) => {
  const bare = tok.replace(/^(\.\.?\/)+/, '');
  const rel = posix.normalize(posix.join(dirname(file), tok));
  if (TRACKED.has(tok) || TRACKED.has(bare) || TRACKED.has(rel)) return undefined;
  return REMOVED_DIRS.find(
    ([d]) =>
      tok.startsWith(d) ||
      bare.startsWith(d) ||
      tok === d.replace(/\/$/, '') ||
      bare === d.replace(/\/$/, ''),
  );
};

const findings = [];
for (const file of scopedDocs(GATED)) {
  for (const { tok, n, line } of citations(file)) {
    const removed = removedDirHit(tok, file);
    if (removed) findings.push({ file, n, tok, line, why: removed[1] });
  }
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.n - b.n);

if (findings.length === 0) {
  console.log(
    `docs path gate: OK — no removed-directory citations in ${GATED.join(', ')}.`,
  );
  process.exit(0);
}

console.error(
  `docs path gate: ${findings.length} citation(s) of a removed directory:\n`,
);
for (const f of findings) {
  console.error(`${f.file}:${f.n}  ${f.tok}`);
  if (f.line) console.error(`    ${f.line.trim()}`);
  console.error(`    -> ${f.why}\n`);
}
console.error(
  'Cite the new location. If the target was deleted rather than moved, say so\n' +
    'in the prose instead of repointing at something that does not exist.\n' +
    'If a directory legitimately belongs in this list or has left it, edit\n' +
    'REMOVED_DIRS in .github/scripts/check-docs-paths.mjs — after checking\n' +
    '`git ls-files <dir>`.',
);
process.exit(1);
