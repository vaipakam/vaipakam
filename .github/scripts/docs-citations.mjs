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
 * It over-matches. It will hand you fragments that are not citations at all:
 * malformed links, text inside parentheses, a destination CommonMark would
 * reject. It does not implement CommonMark and does not try to.
 *
 * **Every consumer must be correct in the presence of over-extraction.**
 *
 * That is not an apology, it is the design. Eleven rounds of review on #1467
 * established the reason, and the finding history sorts almost perfectly:
 *
 *   - Six findings were extraction defects — angle-bracket destinations with
 *     spaces, titled destinations, reference definitions, destinations on the
 *     following line, an unbounded title separator, a zero-width one.
 *   - EVERY ONE of them produced a false POSITIVE only by way of a consumer
 *     that reported anything it could not resolve. Against a consumer that
 *     asks "is this fragment one of these two known-dead names", each was
 *     harmless.
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
  { name: 'code-span', re: /`([^`\n]+)`/g },
  { name: 'angle-destination', re: /\]\(\s*<([^>\n]+)>/g },
  { name: 'inline-destination', re: /\]\(\s*([^)\s<>]+)/g },
  { name: 'reference-definition', re: /^[ ]{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm },
];

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
  for (const { re } of FORMS) {
    for (const m of body.matchAll(re)) {
      const raw = m[1].trim();
      // `path:line` is this repo's ordinary citation form, so the suffix is not
      // part of the name (#1467 r3); query and fragment likewise cannot hide a
      // stale path behind them (#1467 r1).
      const tok = raw.replace(/[.,;:)]+$/, '').split('?')[0].split('#')[0].replace(/:(\d+)(-\d+)?$/, '');
      if (!tok) continue;
      const i = lineAt(m.index + Math.max(0, m[0].indexOf(m[1])));
      out.push({ tok, n: i + 1, line: lines[i] ?? '' });
    }
  }
  return out;
}
