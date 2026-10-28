/**
 * Documentation citations: SCOPE and EXTRACTION.
 *
 * This module answers two questions and deliberately answers no others:
 *
 *   1. Which documents are in scope?
 *   2. Which fragments of a document look like they cite a repository path?
 *
 * Whether a citation is WRONG is not decided here. That separation is the
 * lesson of #1467's review history rather than tidiness for its own sake — see
 * the contract below.
 *
 * ── THE CONTRACT: PRECISE SITES, LOOSE WORDS ──────────────────────────────
 *
 * Until #1486 this extractor found links and code spans with regular
 * expressions and over-matched: it handed out malformed links and
 * destinations CommonMark would reject. Eleven rounds of review on #1467
 * found six such defects (angle-bracket destinations with spaces, titled
 * destinations, reference definitions, destinations on the following line, an
 * unbounded title separator, a zero-width one), and every one became a false
 * alarm ONLY by way of a consumer that reported anything it could not
 * resolve. Patching patterns did not converge, because markdown embedded in
 * prose is an unbounded space: a precise extractor is a real parser or
 * nothing.
 *
 * So the SITES now come from one (`packages/lib/src/markdownCitations.mjs`,
 * micromark with GFM): a destination is what a renderer follows, a code span
 * is what a renderer shows as code, and a raw-HTML comment is neither. Those
 * whole fragments carry `whole: true`.
 *
 * What stays loose on purpose is the WORDS taken out of command text — a code
 * span or a code-block line split into path-shaped shell words (see
 * `pathWords`). They carry `whole: false`. A word is a guess about what a
 * command touches, and `cd contracts && forge test --match-path test/X.t.sol`
 * shows why: `test/X.t.sol` is relative to a directory no parser can know.
 *
 * **Every consumer of a word must remain truthful under over-extraction**: its
 * finding must be a real defect of the DOCUMENT TEXT even when the word is not
 * really a path. A word containing `frontend/` is stale text whatever it is,
 * so the removed-directory rule may read words; a rule keyed on "absent from
 * the tree" may not, because every junk word is absent. That rule reads whole
 * fragments only (#1467 r12, #1486).
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// A relative path: these scripts run under plain Node outside the pnpm
// workspace, and the parser's dependencies resolve from `packages/lib`.
import { markdownCitations } from '../../packages/lib/src/markdownCitations.mjs';

/**
 * Historical records, excluded as a matter of POLICY rather than mechanics.
 *
 * They describe what was true when written, and editing them to match today
 * falsifies the record — which is why #1462 is a scoped card rather than a
 * find-and-replace. `docs/ReleaseNotes/unreleased/` is deliberately NOT here:
 * those fragments are current, PR-authored documentation, not shipped history
 * (#1467 r1).
 */
const SKIP = [
  'docs/FindingsAndFixes/',
  'docs/OlderDocs/',
];
const isShippedReleaseNote = (f) =>
  f.startsWith('docs/ReleaseNotes/') && !f.startsWith('docs/ReleaseNotes/unreleased/');

/**
 * NUL-delimited (#1467 r11). Newline-delimited `git ls-files` returns Git's
 * QUOTED representation for any path outside plain ASCII — `contracts/café.sol`
 * comes back as `"contracts/caf\303\251.sol"` — so a document citing such a
 * file was compared against a string that is not its name, and reading the
 * document could fail outright. `-z` is the documented way to get exact paths.
 */
export function trackedFiles(pathspec = ['.']) {
  return execFileSync('git', ['ls-files', '-z', ...pathspec], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Documents under `prefixes`, minus the historical records.
 *
 * The CALLER chooses the prefixes, because scope is a property of the rule
 * rather than of extraction: a rule that gates at zero has to be scoped to
 * documents somebody has actually cleaned.
 */
export function scopedDocs(prefixes) {
  // Directory pathspecs, not globs: `git ls-files docs/ops/` lists everything
  // beneath it, while `docs/ops/**/*.md` matches only one level in Git's
  // default (non-glob) pathspec mode.
  return trackedFiles(prefixes)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !SKIP.some((d) => f.startsWith(d)))
    .filter((f) => !isShippedReleaseNote(f));
}

/**
 * A code span or fenced block holding a COMMAND is cited path material too
 * (#1467 r12): `cd frontend && npm run deploy` names the removed directory,
 * and extracting the span only as one whole fragment let it slide past a
 * prefix test — two real stale instructions sat in the tree while the gate
 * said zero. Command text is therefore ALSO split into shell words. Splitting
 * is on whitespace and shell metacharacters; path characters (`/`, `.`, `-`,
 * `_`) stay inside a word.
 *
 * Only PATH-SHAPED words are emitted: a word containing `/`, or the argument
 * of `cd`. Emitting every word made the English word "frontend" in commit
 * messages and comments ("Sync frontend ABIs…", "confirm the frontend still
 * typechecks") read as a path citation — the bare-name rule is right for a
 * whole code span (`` `frontend` `` is a deliberate citation) and wrong for a
 * word inside prose-ish command text. The miss this buys (`rm -rf frontend`
 * with no slash and no `cd`) is the stated trade: misses over false alarms.
 */
const SHELL_SPLIT = /[\s&|;()<>"'`,]+/;
function* pathWords(text) {
  let prev = '';
  for (const w of text.split(SHELL_SPLIT)) {
    if (!w) continue;
    if (w.includes('/') || prev === 'cd') yield w;
    prev = w;
  }
}

/**
 * Candidate citations in one document.
 *
 * The SITES come from a CommonMark parser (`markdownCitations`, #1486), so a
 * destination or a code span here is exactly what a renderer would show as
 * one. What is loose is what the gate is offered INSIDE command text: the
 * shell words of a code span or a code-block line, which are path-shaped
 * guesses by design (see `pathWords`). Those carry `whole: false`, and only
 * the closed-world rule may read them.
 *
 * @returns {Array<{tok: string, n: number, line: string, link: boolean, whole: boolean}>} —
 *          `tok` normalised (query, fragment and a trailing `:LINE` removed),
 *          `n` 1-based, `link` true for markdown destinations — the one form
 *          that renders relative to its document (#1467 r13) — and `whole`
 *          true when `tok` is an entire destination or code span rather than
 *          a word taken out of one.
 */
export function citations(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  const seen = new Set();
  const push = (raw, n, link, whole) => {
    // `path:line` is this repo's ordinary citation form, so the suffix is not
    // part of the name (#1467 r3); query and fragment likewise cannot hide a
    // stale path behind them (#1467 r1).
    const tok = raw.replace(/[.,;:)]+$/, '').split('?')[0].split('#')[0].replace(/:(\d+)(-\d+)?$/, '');
    if (!tok) return;
    const key = `${tok}\u0000${n}\u0000${link}\u0000${whole}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tok, n, line: lines[n - 1] ?? '', link, whole });
  };

  for (const { kind, value, line } of markdownCitations(lines.join('\n'))) {
    const raw = value.trim();
    if (kind === 'destination') {
      push(raw, line, true, true);
    } else if (kind === 'code-span') {
      push(raw, line, false, true);
      for (const w of pathWords(raw)) push(w, line, false, false);
    } else {
      // A stale path in a code block is shown to the operator exactly like one
      // in a code span (#1467 r12).
      for (const w of pathWords(value)) push(w, line, false, false);
    }
  }
  return out;
}
