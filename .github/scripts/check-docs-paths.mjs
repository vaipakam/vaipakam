#!/usr/bin/env node
/**
 * Docs check: cited repo paths and app routes exist.
 *
 * WHY THIS EXISTS. Two classes of stale reference kept surfacing in review,
 * and both waste an operator's time at exactly the wrong moment:
 *
 *   - The Stage 3 refactor moved the dApp to `apps/defi`, but 147 references
 *     to the removed `frontend/` directory survived across 39 documents
 *     (#1462). An operator following one looks for a file that is not there.
 *   - The dApp's routes were flattened, so `/app/alerts` became `/alerts`.
 *     Three documents still pointed at the old form — including the incident
 *     runbook's verification step for a notification-channel migration, so
 *     the check an operator runs to confirm the migration worked would have
 *     landed on a blank page.
 *
 * Neither class is preventable by discipline: nothing tells the author of a
 * rename which prose mentions the old name. Both are mechanically decidable,
 * so they are decided here.
 *
 * WHAT IT FLAGS. In non-historical `docs/`:
 *   - a backticked or parenthesised path beginning with a known top-level
 *     directory that does not exist on disk;
 *   - a cited `/app/...` route that the dApp's router does not mount.
 *
 * The route list is DERIVED from `apps/defi/src/App.tsx`, never hand-kept —
 * a hand-kept copy is a second thing to drift, which is the defect this
 * check exists to catch.
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
  ['ops/lz-watcher/', 'deleted with the LayerZero-era ops surface (#1440)'],
];

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
 * any query-bearing dead route bypassed the check entirely — a deep link
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

/**
 * Routes the dApp actually mounts, derived from the router.
 *
 * Collected as the set of `path="…"` values. A cited `/app/x` is a finding
 * only when neither `app/x` nor `x` is mounted — so the surviving
 * back-compat redirect (`app/loans/:loanId`) is correctly accepted, and a
 * flattened route cited under its old prefix is correctly rejected.
 */
function mountedRoutes() {
  const raw = readFileSync('apps/defi/src/App.tsx', 'utf8');
  // Strip comments FIRST (#1467 r2). The file contains route-shaped text
  // inside comments — there is already a `<Route path="app">` in one — so
  // matching the source directly treats documentation and commented-out JSX
  // as live mounts. The failure is in the unsafe direction: if the surviving
  // back-compat redirect were ever commented out during a removal, this set
  // would keep accepting citations of a route React no longer mounts.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  return new Set(
    [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1].replace(/^\//, '')),
  );
}

const routes = mountedRoutes();

/**
 * Is a cited `/app/...` path the CANONICAL form?
 *
 * Deliberately NOT "does the router mount it" (#1467 r3). That question
 * cannot be answered usefully here, and asking it produced a false claim:
 * `App.tsx` nests the whole page tree under `<Route path=":locale">`, and
 * `LocaleResolver` falls back to English for an unrecognised parameter while
 * STILL rendering its outlet —
 *
 *     const target = locale ?? (isSupportedLocale(fromParam) ? fromParam : 'en');
 *     return <>{children ?? <Outlet />}</>;
 *
 * So `:locale` swallows any first segment: `/app/alerts` matches
 * `:locale="app"` plus the live `alerts` child and renders normally. With a
 * catch-all segment no two-part path is ever a 404, which makes a
 * mounted/not-mounted test vacuous — and the earlier message ("the router
 * mounts no such route") simply false.
 *
 * What IS true: `/app/…` is the pre-flattening form. `App.tsx` states the
 * canonical shape is `defi.vaipakam.com/<route>`, "never
 * `defi.vaipakam.com/app/...`", and only `app/loans/:loanId` survives, as a
 * deliberate redirect. Citing the old form points a reader at a URL that
 * works by accident of the locale fallback, under a path the app does not
 * treat as its own. Worth correcting — but it is a wrong path to publish,
 * not a dead link.
 */
const isCanonicalAppPath = (cited) => {
  const bare = cited.replace(/^\/+/, '');
  if (routes.has(bare)) return true;
  // Shape match, so a concrete id (`app/loans/7`) resolves against the
  // surviving parameterised redirect `app/loans/:loanId`.
  const segs = bare.split('/');
  for (const r of routes) {
    const rs = r.split('/');
    if (rs.length !== segs.length) continue;
    if (rs.every((seg, i) => seg.startsWith(':') || seg === segs[i])) return true;
  }
  return false;
};

const findings = [];

for (const file of docs) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Backticked tokens and markdown link targets.
    const tokens = [
      ...[...line.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]),
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ];
    for (const raw of tokens) {
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

      // Resolve a RELATIVE markdown target against the citing doc's own
      // directory (#1467 r1). Operator docs normally link as
      // `../../contracts/script/Foo.s.sol`, and the root-prefix test ignored
      // every one of those — so stale links, and even references to removed
      // directories, landed unnoticed unless the visible label happened to
      // repeat the path in backticks.
      const asRepoPath = tok.startsWith('.')
        ? posix.normalize(posix.join(dirname(file), tok))
        : tok;

      // ── removed / renamed directories: checked EVERYWHERE ───────────
      const removed = REMOVED_DIRS.find(([d]) => asRepoPath.startsWith(d));
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
        continue;
      }

      // ── app routes ──────────────────────────────────────────────────
      // Only the `/app/...` prefix, because that is the one the flattening
      // invalidated; checking every `/x` token would sweep in prose.
      if (/^\/app\/[a-zA-Z][\w:/-]*$/.test(tok) && !isCanonicalAppPath(tok)) {
        findings.push({
          file,
          n: i + 1,
          tok,
          why:
            'non-canonical URL form — the routes were flattened, so the canonical path drops ' +
            'the `/app/` prefix (only `app/loans/:loanId` survives, as a redirect). NOTE this ' +
            'URL does still RESOLVE: `:locale` matches any first segment and LocaleResolver ' +
            'falls back to English, so it renders. It is the wrong path to publish, not a dead one',
        });
      }
    }
  });
}

process.exit(
  report(
    'docs path/route check',
    findings,
    '.github/docs-check-baselines/paths.json',
    { write: process.argv.includes('--write-baseline') },
  ),
);
