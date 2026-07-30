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
 * ── THE CONTRACT: THIS EXTRACTOR IS DELIBERATELY LOOSE ────────────────────
 *
 * It over-matches. It will hand you fragments that are not well-formed
 * citations: malformed links, shell words, a destination CommonMark would
 * reject. It does not implement CommonMark and does not try to.
 *
 * **Every consumer must remain truthful under over-extraction**: a consumer's
 * finding must be a real defect of the DOCUMENT TEXT even when the fragment it
 * fired on is not a well-formed citation. A fragment of `docs/ops/` text that
 * contains `frontend/` is stale text whether or not it parses as a link — so a
 * rule keyed on literally containing a removed name stays truthful on junk
 * fragments, while a rule keyed on "absent from the tree" does not (every junk
 * fragment is absent). Review round 12 sharpened this from an earlier, wronger
 * claim that over-extraction could not make the shipped rule fire at all; it
 * can, and when it does, what it found is still real (#1467 r12).
 *
 * Eleven rounds of review established the underlying asymmetry: all six
 * extraction defects found on this branch (angle-bracket destinations with
 * spaces, titled destinations, reference definitions, destinations on the
 * following line, an unbounded title separator, a zero-width one) became false
 * alarms ONLY by way of a consumer that reported anything it could not resolve.
 *
 * Chasing a precise extractor by patching patterns does not converge: markdown
 * embedded in arbitrary prose is an unbounded space, and each round closed one
 * form and revealed another. A precise extractor is a real parser or nothing.
 * So this one stays honest about being loose, and the correctness burden moves
 * to the consumer — where it can actually be discharged.
 *
 * If a future rule genuinely needs precision (see `check-docs-paths.mjs` for
 * the admission criterion, and #1486 / #1479 / #1472 for the three rules that
 * fail it), the right move is to implement a parser BEHIND this interface, not
 * to keep tightening the patterns in front of it.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  'docs/internal/RoughNotes.md',
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
 * Where a path-shaped fragment can appear.
 *
 * Bounded to code spans and link-ish destinations — NOT every word in the
 * document. Looseness inside these forms is free (see the contract above);
 * looseness about the forms themselves is not, because prose legitimately
 * contains the word "frontend" and a bare-name rule would then fire on
 * ordinary English.
 *
 * The patterns are permissive on purpose: a title separator that may be
 * absent, a destination that may run onto the next line, an angle-bracket form
 * that may contain spaces. Each of those was a review finding when precision
 * mattered; here they simply widen what is offered to the consumer.
 */
const FORMS = [
  { name: 'code-span', re: /`([^`\n]+)`/g, words: true },
  { name: 'angle-destination', re: /\]\(\s*<([^>\n]+)>/g },
  { name: 'inline-destination', re: /\]\(\s*([^)\s<>]+)/g },
  { name: 'reference-definition', re: /^[ ]{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm },
];

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

/** Strip HTML comments, preserving newlines so line numbers stay true. */
const uncomment = (text) =>
  text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Candidate citations in one document.
 *
 * @returns {Array<{tok: string, n: number, line: string}>} — `tok` normalised
 *          (query, fragment and a trailing `:LINE` removed), `n` 1-based.
 */
export function citations(file) {
  const body = uncomment(readFileSync(file, 'utf8'));
  const lines = body.split('\n');

  const starts = [0];
  for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  const lineAt = (idx) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const out = [];
  const seen = new Set();
  const push = (raw, i) => {
    // `path:line` is this repo's ordinary citation form, so the suffix is not
    // part of the name (#1467 r3); query and fragment likewise cannot hide a
    // stale path behind them (#1467 r1).
    const tok = raw.replace(/[.,;:)]+$/, '').split('?')[0].split('#')[0].replace(/:(\d+)(-\d+)?$/, '');
    if (!tok) return;
    const key = `${tok}\u0000${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tok, n: i + 1, line: lines[i] ?? '' });
  };

  for (const { re, words } of FORMS) {
    for (const m of body.matchAll(re)) {
      const raw = m[1].trim();
      const i = lineAt(m.index + Math.max(0, m[0].indexOf(m[1])));
      push(raw, i);
      if (words) for (const w of pathWords(raw)) push(w, i);
    }
  }

  // Fenced code blocks, line by line — a stale path in a fence is shown to the
  // operator exactly like one in a code span (#1467 r12).
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const fenceMark = /^\s*(```|~~~)/.test(lines[i]);
    if (fenceMark) {
      inFence = !inFence;
      continue;
    }
    if (inFence) for (const w of pathWords(lines[i])) push(w, i);
  }

  return out;
}
