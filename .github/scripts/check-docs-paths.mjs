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

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { report } from './docs-check-ratchet.mjs';

const SKIP_DIRS = [
  'docs/ReleaseNotes/',
  'docs/FindingsAndFixes/',
  'docs/OlderDocs/',
  'docs/internal/RoughNotes.md',
];

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
 * The existence half is applied ONLY under STRICT_DIRS below. Run
 * repo-wide it produced 296 findings — design docs legitimately cite
 * planned files, and `docs/ToDo.md` cites historical ones — and a check
 * that reports 296 things gets muted, which is worse than no check. The
 * REMOVED_DIRS half is what runs everywhere.
 */
const ROOTS = [
  'contracts/', 'apps/', 'packages/', 'ops/', 'docs/', '.github/',
  'keeper-bot/', 'frontend/',
];

/**
 * Where a stale path costs an operator or misstates intended behaviour, so
 * the stricter does-it-exist rule is worth its false-positive risk.
 */
const STRICT_DIRS = ['docs/ops/', 'docs/FunctionalSpecs/'];

/** Not resolvable, and legitimately so. */
const UNRESOLVABLE = /[*?{}<>$|]|\.\.\.|\bNNNN\b|^https?:/;

function tracked(glob) {
  return execFileSync('git', ['ls-files', ...glob], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const docs = tracked(['docs/**/*.md', 'docs/*.md']).filter(
  (f) => !SKIP_DIRS.some((d) => f.startsWith(d)),
);

/**
 * Routes the dApp actually mounts, derived from the router.
 *
 * Collected as the set of `path="…"` values. A cited `/app/x` is a finding
 * only when neither `app/x` nor `x` is mounted — so the surviving
 * back-compat redirect (`app/loans/:loanId`) is correctly accepted, and a
 * flattened route cited under its old prefix is correctly rejected.
 */
function mountedRoutes() {
  const src = readFileSync('apps/defi/src/App.tsx', 'utf8');
  return new Set(
    [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1].replace(/^\//, '')),
  );
}

const routes = mountedRoutes();
const routeMounted = (cited) => {
  const bare = cited.replace(/^\/+/, '');
  if (routes.has(bare)) return true;
  // NO "is the flattened form mounted?" fallback. The first cut had one,
  // and it defeated the entire check: `/app/alerts` was accepted BECAUSE
  // `alerts` is mounted — which is precisely the fact that makes the
  // citation wrong. `/app/alerts` 404s regardless of what `/alerts` does.
  //
  // A parameterised mount still matches by segment shape, which is what
  // legitimately accepts the surviving `app/loans/:loanId` redirect.
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
      const tok = raw.replace(/[.,;:)]+$/, '');
      if (UNRESOLVABLE.test(tok)) continue;

      // ── removed / renamed directories: checked EVERYWHERE ───────────
      const removed = REMOVED_DIRS.find(([d]) => tok.startsWith(d));
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
        ROOTS.some((r) => tok.startsWith(r))
      ) {
        const path = tok.split('#')[0];
        if (!existsSync(path)) {
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
      if (/^\/app\/[a-zA-Z][\w:/-]*$/.test(tok) && !routeMounted(tok)) {
        findings.push({
          file,
          n: i + 1,
          tok,
          why: `the dApp router mounts no such route (routes were flattened; the only surviving \`/app/\` path is the loan back-compat redirect)`,
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
