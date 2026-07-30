#!/usr/bin/env node
/**
 * Docs check: cited repo paths exist.
 *
 * WHY THIS EXISTS. The Stage 3 refactor moved the dApp to `apps/defi`, but
 * 147 references to the removed `frontend/` directory survived across 39
 * documents (#1462). An operator following one looks for a file that is not
 * there, at exactly the moment they can least afford to.
 *
 * The class is not preventable by discipline: nothing tells the author of a
 * rename which prose mentions the old name. It IS mechanically decidable, so
 * it is decided here.
 *
 * WHAT IT FLAGS. In non-historical `docs/`:
 *   - a citation of a directory that was removed or renamed (`REMOVED_DIRS`),
 *     anywhere in the doc set — set membership, so no judgement is involved;
 *   - under `docs/ops/` and `docs/FunctionalSpecs/`, a cited path beginning
 *     with a known top-level directory that is not in the tracked tree.
 *
 * WHY THERE IS NO `/app/...` ROUTE CHECK. There was one, across four review
 * rounds, and it is DEFERRED to #1479 rather than shipped. It was not failing
 * for want of another patch: each round closed a real gap and the next found
 * another citation form the pattern mishandled — a trailing slash (`/app/`), a
 * locale prefix (`/es/app/alerts`), a same-origin absolute URL
 * (`https://defi.vaipakam.com/app/alerts`). Citation forms are an unbounded
 * set, so a pattern over them is a heuristic; the removed-directory rule is a
 * set-membership test over a list someone maintains deliberately. Shipping the
 * second without the first is the whole point — a check that is sometimes
 * wrong teaches people to ignore the one that never is.
 *
 * (The route work still produced two durable results, both kept: the five
 * stale `/app` citations it found are corrected in this change, and it
 * disproved a claim I had asserted three times — that `/app/alerts` shows an
 * operator a blank page. It does not. `App.tsx` nests the page tree under
 * `<Route path=":locale">` and `LocaleResolver` falls back to English for an
 * unrecognised parameter while still rendering its outlet, so the old form
 * resolves. It is the wrong address to publish, not a dead one.)
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG:
 *   - Historical records (release notes, findings, older docs). They
 *     describe what was true when written; editing them falsifies the
 *     record. This is why #1462 is not a bulk find-and-replace.
 *   - Globs, placeholders (`<slug>`, `NNNN_`, `*`), URLs, and paths with
 *     shell/template interpolation — all legitimately non-resolvable.
 *   - Bare filenames without a directory, which are usually prose.
 *
 * WHAT IT CANNOT SEE: a path that exists but is the WRONG one, and any
 * reference outside a backtick or link. It closes staleness, not accuracy.
 */

import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { report } from './docs-check-ratchet.mjs';

// `docs/ReleaseNotes/unreleased/` is deliberately NOT skipped — those
// fragments are current, PR-authored docs, not shipped history (#1467 r1).
const SKIP_DIRS = [
  'docs/FindingsAndFixes/',
  'docs/OlderDocs/',
  'docs/internal/RoughNotes.md',
];
const isShippedReleaseNote = (f) =>
  f.startsWith('docs/ReleaseNotes/') &&
  !f.startsWith('docs/ReleaseNotes/unreleased/');

/**
 * Directories that were REMOVED or renamed. A citation of one of these is
 * wrong wherever it appears, with no judgement needed — which makes this
 * the zero-false-positive core of the check, and exactly the #1462 class.
 *
 * Add an entry whenever a directory is deleted or moved. That is the one
 * manual step, and it is the right one: the person doing the rename is the
 * only one who knows it happened.
 */
const REMOVED_DIRS = [
  ['frontend/', 'the dApp moved to `apps/defi/` in the Stage 3 refactor'],
  ['ops/hf-watcher/', 'split into `apps/{keeper,agent,indexer}` (Stage 3)'],
  // `ops/lz-watcher/` was listed here and is NOT removed (#1467 r5). It is
  // 16 tracked files, and `docs/ops/AdminKeysAndPause.md` records that its
  // decommission is DEFERRED. Because this list is consulted before the
  // tracked-tree lookup, listing it made two live citations read as
  // nonexistent and would have turned every future one into a regression —
  // the check asserting a fact about the tree that the tree contradicts,
  // which is the exact defect it exists to catch. Verify with
  // `git ls-files <dir>` before adding an entry; if the directory is still
  // tracked, it does not belong here.
];

/**
 * A citation hits a removed directory if it names it as a prefix OR IS it
 * exactly (#1467 r5). `startsWith('frontend/')` alone missed a bare
 * `` `frontend` ``, which is the same stale name and the commonest prose form
 * of it.
 */
const removedDirHit = (p) =>
  REMOVED_DIRS.find(([d]) => p.startsWith(d) || p === d.replace(/\/$/, ''));

/**
 * Top-level dirs that make a token unambiguously a repo path.
 *
 * DERIVED from the tracked tree, not hand-listed (#1467 r2). The hand-written
 * list silently omitted `audits/` and `cdpwalkthrough/`, so a stale citation
 * under either never reached the existence check — the check quietly did not
 * cover part of the repo it claimed to. A hand-kept list of what exists is
 * the same defect class this check was written to catch, so keeping one here
 * was self-defeating.
 *
 * `tracked` is a hoisted function declaration, so calling it above its
 * textual position is fine.
 *
 * The existence half is applied ONLY under STRICT_DIRS below. Run repo-wide
 * it produced far more findings than anyone would read — design docs
 * legitimately cite planned files, and `docs/ToDo.md` cites historical ones —
 * and a check nobody reads is worse than no check. The REMOVED_DIRS half runs
 * everywhere.
 */
const ROOTS = (() => {
  const dirs = new Set();
  for (const f of tracked(['.'])) {
    const slash = f.indexOf('/');
    if (slash > 0) dirs.add(`${f.slice(0, slash)}/`);
  }
  // Removed directories cannot be derived from a tree they are absent from,
  // and are precisely what must still be recognised as path-shaped.
  for (const [d] of REMOVED_DIRS) dirs.add(d);
  return [...dirs];
})();

/**
 * Where a stale path costs an operator or misstates intended behaviour, so
 * the stricter does-it-exist rule is worth its false-positive risk.
 */
const STRICT_DIRS = ['docs/ops/', 'docs/FunctionalSpecs/'];

/**
 * Not resolvable, and legitimately so.
 *
 * `?` is NOT here (#1467 r1). Treating a query string as unresolvable meant
 * any citation carrying one bypassed the check entirely, so a deep link
 * concealed the staleness. Query and fragment are now STRIPPED before
 * matching instead.
 */
const UNRESOLVABLE = /[*{}<>$|]|\.\.\.|\bNNNN\b|^https?:|^mailto:/;

function tracked(glob) {
  return execFileSync('git', ['ls-files', ...glob], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const docs = tracked(['docs/**/*.md', 'docs/*.md'])
  .filter((f) => !SKIP_DIRS.some((d) => f.startsWith(d)))
  .filter((f) => !isShippedReleaseNote(f));

/**
 * Existence is decided from the TRACKED tree, not the working tree (#1467 r1).
 *
 * `existsSync` made the result depend on whichever untracked files happen to
 * sit in the checkout: `contracts/.env` exists on a developer's machine and
 * not in CI, so a baseline generated locally was 6 findings short of what CI
 * would compute — and the check would have warned from its first run, which
 * is exactly the red-on-arrival failure the ratchet exists to avoid. A repo
 * path cited in the docs should resolve for everyone, so the tracked tree is
 * the right authority; operator-created files (`contracts/.env`) legitimately
 * do not resolve and must not be cited as if they were repo content.
 */
const TRACKED = new Set(tracked(['.']));
const TRACKED_DIRS = new Set();
for (const f of TRACKED) {
  const parts = f.split('/');
  for (let i = 1; i < parts.length; i++) TRACKED_DIRS.add(parts.slice(0, i).join('/'));
}
const resolves = (p) => {
  const clean = p.replace(/\/+$/, '');
  return TRACKED.has(clean) || TRACKED_DIRS.has(clean);
};

const findings = [];

for (const file of docs) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Backticked tokens and markdown link targets. The two are kept apart
    // because they resolve DIFFERENTLY (#1467 r2): a markdown destination is
    // relative to its own document wherever it does not start with `/`, while
    // a backticked path is the repo-root citation form this repo writes in
    // prose. Collapsing them made a genuinely broken link read as fine —
    // `[x](contracts/src/Foo.sol)` inside `docs/ops/` was accepted because the
    // repo-root file exists, though the rendered link points at the
    // nonexistent `docs/ops/contracts/src/Foo.sol`.
    const tokens = [
      ...[...line.matchAll(/`([^`\s]+)`/g)].map((m) => ({ raw: m[1], link: false })),
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => ({ raw: m[1], link: true })),
    ];
    for (const { raw, link } of tokens) {
      // Strip query + fragment first, so a deep link cannot hide a dead
      // route or path behind them (#1467 r1).
      // Strip a trailing `:LINE` or `:START-END` before resolving (#1467 r3).
      // `path:line` is this repo's ordinary citation form — its own docs use
      // it — and treating the suffix as part of the filename reported tracked
      // files as missing.
      const tok = raw
        .replace(/[.,;:)]+$/, '')
        .split('?')[0]
        .split('#')[0]
        .replace(/:(\d+)(-\d+)?$/, '');
      if (!tok || UNRESOLVABLE.test(tok)) continue;

      // Resolve against the citing doc's own directory whenever that is how
      // the reference actually resolves: every markdown destination that is
      // not site-absolute (#1467 r2), and any explicitly relative backticked
      // path (#1467 r1). Operator docs normally link as
      // `../../contracts/script/Foo.s.sol`, and the root-prefix test ignored
      // every one of those — so stale links, and even references to removed
      // directories, landed unnoticed unless the visible label happened to
      // repeat the path in backticks.
      const docRelative = tok.startsWith('.') || (link && !tok.startsWith('/'));
      const asRepoPath = docRelative
        ? posix.normalize(posix.join(dirname(file), tok))
        : tok;

      // ── removed / renamed directories: checked EVERYWHERE ───────────
      //
      // Tested against the token AS WRITTEN as well as the resolved path,
      // because a removed name is wrong under either reading — and after
      // doc-relative resolution a link target such as `frontend/src/x.tsx`
      // no longer starts with `frontend/`.
      const removed = removedDirHit(asRepoPath) ?? removedDirHit(tok);
      if (removed) {
        findings.push({
          file,
          n: i + 1,
          tok,
          why: `\`${removed[0]}\` no longer exists — ${removed[1]}`,
        });
        continue;
      }

      // ── does-it-exist: only in the live operator / spec docs ────────
      if (
        STRICT_DIRS.some((d) => file.startsWith(d)) &&
        ROOTS.some((r) => asRepoPath.startsWith(r))
      ) {
        if (!resolves(asRepoPath)) {
          findings.push({
            file,
            n: i + 1,
            tok,
            why: `path does not exist. If it moved, cite the new location; if it was removed, say so`,
          });
        }
      }
    }
  });
}

process.exit(
  report(
    'docs path check',
    findings,
    '.github/docs-check-baselines/paths.json',
    { write: process.argv.includes('--write-baseline') },
  ),
);
