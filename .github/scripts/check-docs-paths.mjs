#!/usr/bin/env node
/**
 * Docs gate: no operator runbook cites a directory that no longer exists, or
 * links to or shows as code a repository path the tracked tree does not have.
 *
 * WHY THIS EXISTS. The Stage 3 refactor moved the dApp to `apps/app`, but 147
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
 * Three open-world rules were built on #1467 and deferred, each needing a
 * precise extractor — which means a real parser, not more patches to a loose
 * one:
 *
 *   - does-it-exist against the tracked tree ...... #1486, SHIPPED (rule 2)
 *   - non-canonical `/app/…` URL citations ........................ #1479
 *   - secrets reaching a command's argv ........................... #1472
 *
 * Each was deferred separately, on its own judgement call, before anyone
 * noticed they fail the same test. That they fall out of one criterion is the
 * evidence the criterion is real rather than a rationalisation. The first
 * shipped the way the criterion said it would: a CommonMark parser now finds
 * the links and code spans (`docs-citations.mjs`), and the rule reads only
 * those whole sites, never the words taken out of command text.
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

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
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
  ['frontend/', 'the dApp moved to `apps/app/`, and its contract bundle to `packages/contracts/`, in the Stage 3 refactor'],
  ['ops/hf-watcher/', 'split into `apps/{keeper,indexer,agent}` (Stage 3)'],
  // #1854 — the connected-app cutover. `apps/alpha02` was RENAMED to
  // `apps/app`; the other three were deleted outright and have no
  // successor path, so a citation to them is only ever historical.
  ['apps/alpha02/', 'renamed to `apps/app/` at the #1854 cutover'],
  ['apps/defi/', 'retired in #1854 — the connected app is `apps/app/`; note Analytics and the Protocol Console were NOT ported (#1959), so cite git history for those'],
  ['apps/alpha01/', 'prototype deleted in #1854 — cite git history'],
  ['apps/alpha/', 'prototype deleted in #1854 — cite git history'],
  // #2538 — the alpha01 prototype's orchestration package, orphaned by
  // #1854 and deleted once nothing had adopted it. `apps/app` carries the
  // one shipping copy of what it duplicated.
  ['packages/defi-client/', 'deleted in #2538 (orphaned since #1854) — the shipping code is in `apps/app/`; cite git history'],
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
 * follows how each FORM actually reads (#1467 r12, narrowed in r13): a markdown
 * DESTINATION also resolves relative to its citing document, because that is
 * how it renders — but a CODE SPAN is this repo's repository-root citation
 * form, so giving it the document-relative reading would acquit a root-stale
 * `` `frontend/guide.md` `` whenever the citing doc happened to sit next to a
 * same-named live file. Using the tree to ACCUSE is the open-world rule, which
 * runs below as rule 2 and only on whole sites a parser found (#1486).
 */
const removedDirHit = (tok, file, link) => {
  const bare = tok.replace(/^(\.\.?\/)+/, '');
  const rel = link ? posix.normalize(posix.join(dirname(file), tok)) : null;
  if (TRACKED.has(tok) || TRACKED.has(bare) || (rel && TRACKED.has(rel))) return undefined;
  return REMOVED_DIRS.find(
    ([d]) =>
      tok.startsWith(d) ||
      bare.startsWith(d) ||
      tok === d.replace(/\/$/, '') ||
      bare === d.replace(/\/$/, ''),
  );
};

// ── RULE 2: THE CITED PATH EXISTS (#1486) ────────────────────────────────
//
// The open-world rule the admission criterion kept out while the extractor was
// a set of regular expressions. It is admitted now because of what it reads,
// not because it got more careful: only WHOLE sites, as a CommonMark parser
// found them (`whole: true` in `docs-citations.mjs`), never a shell word. A
// finding is then "this document links to, or shows as code, a repository path
// that the tracked tree does not have", which is a defect of the text whatever
// else the fragment is.
//
// Which whole sites are repository-path claims, and how each resolves, are the
// adjudication rules #1467 established and verified by injection (each
// numbered below where it is applied):
//
//   (1) existence is the TRACKED tree, from `git ls-files -z` — never the
//       working tree, which holds build output and local files;
//   (2) a trailing slash resolves only as a directory, and a tracked gitlink
//       (a submodule) is a directory whose contents this tree cannot see;
//   (3) a markdown destination resolves against its own document, as it
//       renders; a code span resolves from the repository root, which is this
//       repository's citation form. A code span starting `./` or `../` is
//       relative to a working directory, so it claims nothing this rule can
//       check (see `claimedPath`);
//   (4) a path the COMMITTED `.gitignore` files ignore is not a finding (a
//       runbook tells the operator to create `contracts/.env`) — but a
//       global `core.excludesFile` or `.git/info/exclude` must not exempt
//       anything, and a negated pattern is not an exemption;
//   (5) a URI with a scheme, a protocol-relative `//host/…` and a site-root
//       `/route` are not repository paths;
//   (6) a candidate escaping the repository is dropped before the ignore
//       check, because one such path makes Git fail the whole batch.
//
// One rule is new here, because a code span is not only ever a path: a span
// is a root-relative path claim only when its first segment is a tracked
// top-level entry (`contracts/…`, `docs/…`, `.github/…`). `read/write`,
// `owner/repo` and a bare `Foo.md` are words, not citations, and a rule that
// read them as paths would be the open-world false alarm again. Placeholders
// and patterns (`<slug>`, `*`, `{a,b}`, `$VAR`, `~`) are skipped for the same
// reason: they describe paths rather than name one.

/** (2) Every tracked directory, and every gitlink. */
const GITLINKS = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((e) => e.startsWith('160000 '))
  .map((e) => e.slice(e.indexOf('\t') + 1));
const DIRS = new Set(GITLINKS);
for (const f of [...TRACKED, ...GITLINKS]) {
  for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) DIRS.add(d);
}
const TOP = new Set([...TRACKED, ...DIRS].map((p) => p.split('/')[0]));
const underGitlink = (p) => GITLINKS.some((g) => p === g || p.startsWith(`${g}/`));

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NOT_A_NAME = /[\s*?{}[\]<>$~|\\"'`]/;

/**
 * Percent-escapes in a link resolve on GitHub; a malformed one stays as written.
 * `tok` is already the path alone (query and fragment were split off before
 * decoding), so every escape is decoded, the reserved ones included: an
 * escaped `#`, `?` or `+` is part of the file name, and `decodeURI` would
 * leave it encoded and look for `a%23b.md` instead of `a#b.md`.
 */
const decoded = (tok) => {
  try {
    return decodeURIComponent(tok);
  } catch {
    return tok;
  }
};

/**
 * The repository path a whole site claims, or null when it claims none.
 * Returns `{ path, dir }`: `dir` when it was cited with a trailing slash.
 *
 * `src` is the site as written. A code span is tested for pattern characters
 * there, not in `tok`: normalisation reads `?` as the start of a URL query and
 * drops it with everything after, so `contracts/src/Live?.sol` would reach
 * this rule as the literal `contracts/src/Live` and be accused of not existing.
 */
function claimedPath(tok, src, file, link) {
  if (HAS_SCHEME.test(tok) || tok.startsWith('/')) return null; // (5)
  // A code span may name a part of a file (`wrangler.jsonc:vars`), as it may
  // name a line; the part is not in the path.
  const raw = link ? decoded(tok) : tok.replace(/:[A-Za-z_][\w.-]*$/, '');
  if (!link) {
    if (NOT_A_NAME.test(raw) || NOT_A_NAME.test(src)) return null;
    // (3), narrowed for accusing. `./x` and `../x` in a code span are
    // relative to a working directory the text names in prose, if at all
    // (`./tickets.sql` from `apps/indexer/`), so they have no base this rule
    // can resolve. #1467 read them document-relative, which is right for
    // ACQUITTING a removed-directory hit and wrong for accusing.
    if (raw.startsWith('./') || raw.startsWith('../')) return null;
    if (!TOP.has(raw.split('/')[0])) return null;
  }
  const joined = link ? posix.join(dirname(file), raw) : raw;
  const path = posix.normalize(joined).replace(/\/$/, '');
  if (path === '.' || path === '..' || path.startsWith('../')) return null; // (6)
  return { path, dir: raw.endsWith('/') };
}

const exists = ({ path, dir }) =>
  underGitlink(path) || DIRS.has(path) || (!dir && TRACKED.has(path)); // (1) (2)

/**
 * (4) The subset of `paths` the committed `.gitignore` files ignore.
 *
 * Git consults the user's global excludes file and `.git/info/exclude` as
 * well as the tree's `.gitignore` files, and neither of those is part of the
 * repository. So the check runs in a scratch repository holding ONLY the
 * committed `.gitignore` files, with the global and system configuration
 * switched off. Without `--verbose`, `check-ignore` lists only paths that end
 * up ignored, so a path a negated pattern re-includes is not listed.
 */
function committedIgnored(paths) {
  if (paths.length === 0) return new Set();
  const scratch = mkdtempSync(join(tmpdir(), 'docs-paths-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q', '--template=', scratch], { env });
    for (const g of trackedFiles([':(glob)**/.gitignore'])) {
      mkdirSync(join(scratch, posix.dirname(g)), { recursive: true });
      writeFileSync(join(scratch, g), execFileSync('git', ['show', `:${g}`]));
    }
    const res = spawnSync(
      'git',
      ['-C', scratch, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin', '-z'],
      { env, input: paths.join('\0'), encoding: 'utf8' },
    );
    // 0: some paths are ignored; 1: none are; anything else is a failure,
    // never a verdict.
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(`git check-ignore failed (${res.status}): ${res.stderr}`);
    }
    return new Set(res.stdout.split('\0').filter(Boolean));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const findings = [];
const missing = [];
for (const file of scopedDocs(GATED)) {
  for (const { tok, src, n, line, link, whole } of citations(file)) {
    const removed = removedDirHit(tok, file, link);
    if (removed) {
      findings.push({ file, n, tok, line, why: removed[1] });
      continue;
    }
    if (!whole) continue;
    const claim = claimedPath(tok, src, file, link);
    if (claim && !exists(claim)) missing.push({ file, n, tok, line, claim });
  }
}
const ignored = committedIgnored([...new Set(missing.map(({ claim }) => claim.path + (claim.dir ? '/' : '')))]);
for (const m of missing) {
  if (ignored.has(m.claim.path + (m.claim.dir ? '/' : ''))) continue;
  findings.push({
    ...m,
    why:
      m.claim.path === m.tok
        ? `\`${m.claim.path}\` is not in the tracked tree${m.claim.dir ? ' as a directory' : ''}`
        : `resolves to \`${m.claim.path}\`, which is not in the tracked tree${m.claim.dir ? ' as a directory' : ''}`,
  });
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.n - b.n);

if (findings.length === 0) {
  console.log(
    `docs path gate: OK — every cited path exists, and no removed-directory citations, in ${GATED.join(', ')}.`,
  );
  process.exit(0);
}

console.error(`docs path gate: ${findings.length} citation(s) to fix:\n`);
for (const f of findings) {
  console.error(`${f.file}:${f.n}  ${f.tok}`);
  if (f.line) console.error(`    ${f.line.trim()}`);
  console.error(`    -> ${f.why}\n`);
}
console.error(
  'Cite the path as it is now. If the target was deleted rather than moved, say\n' +
    'so in the prose instead of pointing at something that does not exist. If a\n' +
    'path is one the reader is told to CREATE, it belongs in a committed\n' +
    '.gitignore. If a directory legitimately belongs in REMOVED_DIRS or has left\n' +
    'it, edit that list in .github/scripts/check-docs-paths.mjs — after checking\n' +
    '`git ls-files <dir>`.',
);
process.exit(1);
