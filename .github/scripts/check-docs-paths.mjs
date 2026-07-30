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
 *     with a known top-level directory that is not in the tracked tree, and
 *     any markdown link destination that does not resolve at all.
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
 *
 * ANY URI scheme, and protocol-relative `//host/…`, not just `http(s):` and
 * `mailto:` (#1467 r8). The documentation said URLs were exempt while the code
 * exempted two schemes, so `tel:` and `//cdn.example.com/x` were reported as
 * missing repository paths — false findings in the strict documents, which are
 * the ones whose signal has to be trustworthy. The scheme pattern cannot swallow
 * a repo path: `/` is not in its character class, so `apps/defi/src/App.tsx:1`
 * has a slash before its colon and never matches.
 */
const UNRESOLVABLE =
  /[*{}<>$|]|\.\.\.|\bNNNN\b|^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//;

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
/**
 * Submodule roots are directories, but `git ls-files` reports each as a single
 * gitlink ENTRY with no children, so the ancestor walk above never adds the
 * root itself (#1467 r10). Harmless until r9 made a trailing slash mean
 * "directory" — after which `contracts/lib/limit-order-protocol/` stopped
 * resolving. A regression my own fix introduced, which is why the trailing-slash
 * change needed a probe on BOTH the file and directory forms and got one only
 * for ordinary directories.
 */
for (const line of execFileSync('git', ['ls-files', '--stage'], { encoding: 'utf8' }).split('\n')) {
  const m = line.match(/^160000 [0-9a-f]+ \d+\t(.+)$/);
  if (m) TRACKED_DIRS.add(m[1]);
}
/**
 * A trailing slash means DIRECTORY, so it may only resolve as one (#1467 r9).
 * Stripping it before the lookup let `../../contracts/README.md/` resolve as
 * the tracked file — but a file cannot be traversed as a directory, so that
 * destination is broken and the check excused it.
 */
const resolves = (p) => {
  const dirOnly = /\/$/.test(p);
  const clean = p.replace(/\/+$/, '');
  return dirOnly ? TRACKED_DIRS.has(clean) : TRACKED.has(clean) || TRACKED_DIRS.has(clean);
};

/**
 * Paths the repository deliberately IGNORES are intentionally untracked, so
 * citing one is correct rather than stale (#1467 r9). A runbook telling an
 * operator to create `contracts/.env` is right, and calling that a stale
 * citation is the check contradicting the repo's own stated intent —
 * `.gitignore` IS that statement, which is what makes this decidable rather
 * than a guess.
 *
 * `git check-ignore` exits 1 when nothing matches, which `execFileSync` throws
 * on; an empty result is the correct reading of that.
 *
 * This does NOT cover a generated artifact that is neither tracked nor
 * ignored — nothing in the repo distinguishes one of those from a typo. That
 * is the case for a reasoned allowlist entry when the check becomes a gate
 * (#1468), not for a silent exemption here.
 */
function ignoredPaths(candidates) {
  // A path that normalises OUTSIDE the repository makes `git check-ignore` exit
  // 128 for the whole batch, which `execFileSync` throws on — so one broken
  // escaping link discarded the ignore result for every other candidate and
  // re-reported all seven legitimate `.env` citations as regressions (#1467
  // r10). Failing in the direction of noise is the failure that gets a check
  // switched off, so escaping and absolute paths are dropped before the call;
  // they cannot be repo-ignored anyway.
  const safe = candidates.filter((c) => c && !c.startsWith('../') && !c.startsWith('/'));
  if (!safe.length) return new Set();
  let out;
  try {
    // `-v` names the ignore FILE that matched, which is what makes the next
    // filter possible.
    out = execFileSync('git', ['check-ignore', '-v', '--stdin'], {
      input: safe.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    // Exit 1 means nothing matched, which is a real answer, not an error.
    return new Set();
  }

  const ignored = new Set();
  for (const line of out.split('\n')) {
    // `<source>:<line>:<pattern>\t<path>`
    const tab = line.lastIndexOf('\t');
    if (tab < 0) continue;
    const source = line.slice(0, line.indexOf(':'));
    const path = line.slice(tab + 1);
    // ONLY a committed `.gitignore` counts (#1467 r10). `git check-ignore` also
    // consults `core.excludesFile` and `.git/info/exclude`, so without this the
    // verdict depends on the developer's own configuration — the exact
    // environment-dependence that replacing `existsSync` with the tracked tree
    // was introduced to remove in r1, quietly reintroduced by r9's fix. A
    // global exclude could silently exempt a typo that CI would report.
    if (TRACKED.has(source)) ignored.add(path);
  }
  return ignored;
}

const findings = [];
const pending = [];   // {file, n, line, tok, link} awaiting the gitignore pass

/**
 * At most ONE newline of separating whitespace.
 *
 * CommonMark lets a destination sit on the line after its opener — both
 * `[ref]:\n  ../path` and `[x](\n  ../path)` are real links — and scanning line
 * by line meant no pattern ever saw the opener and the destination together, so
 * a broken link written that way bypassed the check entirely (#1467 r9). The
 * document is now scanned whole. Bounded to a single newline rather than `\s*`
 * on purpose: a blank line ENDS a link in CommonMark, so allowing more would
 * match text that is not a link at all.
 */
const WS = '[^\\S\\n]*\\n?[^\\S\\n]*';

const PATTERNS = [
  // Backticked repo-path citations — this repo's prose form.
  { re: /`([^`\s]+)`/g, link: false },
  // Inline destination, angle-bracket form. Matched FIRST and separately
  // because markdown permits SPACES inside it (#1467 r7) — `](<a path>)` —
  // which a whitespace-excluding capture cannot see at all.
  { re: new RegExp(`\\]\\(${WS}<([^>\\n]+)>`, 'g'), link: true },
  // Inline destination, bare form, with an optional title.
  // The title separator is bounded by `WS` too (#1467 r10). Leaving it `\s+`
  // let it cross a blank line, and a blank line ENDS a link — so
  // `[x](path\n\n "title")` is not a link at all, yet the destination was
  // extracted and reported. An inconsistency inside r9's own bounding rule
  // rather than a new markdown form.
  { re: new RegExp(`\\]\\(${WS}([^)\\s<>]+)(?:${WS}["'(][^)]*)?${WS}\\)`, 'g'), link: true },
  // A reference DEFINITION takes the same two forms as an inline link, so it
  // needs the same two patterns (#1467 r8). Fixing only the inline sibling in
  // r7 left this one capturing the whitespace-free PREFIX of a spaced
  // destination — and a prefix that happens to name a real directory reads as
  // resolving, so the broken destination was not merely missed but excused.
  { re: new RegExp(`^[ ]{0,3}\\[[^\\]]+\\]:${WS}<([^>\\n]+)>`, 'gm'), link: true },
  { re: new RegExp(`^[ ]{0,3}\\[[^\\]]+\\]:${WS}([^\\s<>]+)`, 'gm'), link: true },
];

for (const file of docs) {
  // Strip HTML comments before tokenising (#1467 r6). A path inside
  // `<!-- … -->` is invisible to every reader of the rendered document, so a
  // finding on one is unactionable noise — and this check's entire claim is
  // that its signal is worth reading. Newlines are preserved so the line
  // numbering below still points at the right place.
  const body = readFileSync(file, 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    (m) => m.replace(/[^\n]/g, ' '),
  );
  const lines = body.split('\n');

  // Cumulative offsets, so a match index maps back to the line that CARRIES
  // the destination — which is the line a reader has to edit, and the line the
  // ratchet fingerprints.
  const lineStarts = [0];
  for (let i = 0; i < lines.length; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1);
  const lineAt = (idx) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const tokens = [];
  for (const { re, link } of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const at = m.index + Math.max(0, m[0].indexOf(m[1]));
      tokens.push({ raw: m[1].trim(), link, i: lineAt(at) });
    }
  }

  for (const { raw, link, i } of tokens) {
    const line = lines[i] ?? '';
    // Strip query + fragment first, so a deep link cannot hide a dead path
    // behind them (#1467 r1). Strip a trailing `:LINE` or `:START-END` before
    // resolving (#1467 r3) — `path:line` is this repo's ordinary citation
    // form, and treating the suffix as part of the filename reported tracked
    // files as missing.
    const tok = raw
      .replace(/[.,;:)]+$/, '')
      .split('?')[0]
      .split('#')[0]
      .replace(/:(\d+)(-\d+)?$/, '');
    if (!tok || UNRESOLVABLE.test(tok)) continue;

    // Resolve against the citing doc's own directory whenever that is how the
    // reference actually resolves: every markdown destination that is not
    // site-absolute (#1467 r2), and any explicitly relative backticked path
    // (#1467 r1). `./` or `../` ONLY for a backtick — not every dot-prefixed
    // token (#1467 r6), which swept in dot-DIRECTORIES and froze 44 false
    // findings in the baseline.
    const docRelative =
      tok.startsWith('./') || tok.startsWith('../') || (link && !tok.startsWith('/'));
    const asRepoPath = docRelative
      ? posix.normalize(posix.join(dirname(file), tok))
      : tok;

    // ── removed / renamed directories: checked EVERYWHERE ─────────────
    //
    // Tested against the token AS WRITTEN as well as the resolved path,
    // because a removed name is wrong under either reading — and after
    // doc-relative resolution a link target such as `frontend/src/x.tsx` no
    // longer starts with `frontend/`. The as-written test is skipped when the
    // resolved path RESOLVES (#1467 r6): evidence beats the name.
    const removed =
      removedDirHit(asRepoPath) ?? (resolves(asRepoPath) ? undefined : removedDirHit(tok));
    if (removed) {
      findings.push({
        file,
        n: i + 1,
        tok,
        line,
        why: `\`${removed[0]}\` no longer exists — ${removed[1]}`,
      });
      continue;
    }

    // ── does-it-exist: only in the live operator / spec docs ──────────
    //
    // A markdown DESTINATION skips the `ROOTS` gate entirely (#1467 r6). The
    // gate tells a repo path from ordinary prose, and a destination is never
    // prose — it is a promise that clicking it lands somewhere. Gating it left
    // two holes: a destination climbing out of the repository normalises to
    // `../…` and matches no root, and `ROOTS` comes from the CURRENT tree, so
    // deleting the last file under a directory stopped every stale link into
    // it from being checked in the same commit that broke them.
    const gated = link || ROOTS.some((r) => asRepoPath.startsWith(r));
    if (STRICT_DIRS.some((d) => file.startsWith(d)) && gated) {
      if (!resolves(asRepoPath)) pending.push({ file, n: i + 1, tok, line, asRepoPath });
    }
  }
}

// One `git check-ignore` pass for every unresolved candidate, rather than one
// per token (#1467 r9).
const ignored = ignoredPaths([...new Set(pending.map((f) => f.asRepoPath))]);
for (const f of pending) {
  if (ignored.has(f.asRepoPath)) continue;
  findings.push({
    file: f.file,
    n: f.n,
    tok: f.tok,
    line: f.line,
    why: `path does not exist. If it moved, cite the new location; if it was removed, say so`,
  });
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.n - b.n);

process.exit(
  report(
    'docs path check',
    findings,
    '.github/docs-check-baselines/paths.json',
    { write: process.argv.includes('--write-baseline') },
  ),
);
