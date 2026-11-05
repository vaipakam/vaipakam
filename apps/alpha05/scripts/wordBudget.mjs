/**
 * The word-budget rule (RB-TIERS), kept apart from the file walk so vitest
 * can test it. A copy entry is `A('...')`, `B('...')` or `C('...')` from
 * src/shared/copy/tiers.ts. Tier B is budgeted: it is the one tier that is
 * both inline and foldable, so it is where clutter grows. Tier A is exempt
 * (consent and consequence are never cut) and tier C is never inline.
 */

/** Must equal TIER_B_WORD_BUDGET in src/shared/copy/tiers.ts (pinned by the
 *  test beside this file). */
export const TIER_B_WORD_BUDGET = 18;

const ENTRY = /\b([ABC])\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;

export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * @param {string} source a TypeScript source file's text
 * @param {string} file its path, for the report
 * @returns {{ file: string, line: number, words: number, text: string }[]} the tier-B entries over budget
 */
export function overBudget(source, file) {
  const out = [];
  for (const m of source.matchAll(ENTRY)) {
    const [, tier, , raw] = m;
    if (tier !== 'B') continue;
    const text = raw.replace(/\\(.)/g, '$1');
    const words = wordCount(text);
    if (words > TIER_B_WORD_BUDGET) {
      const line = source.slice(0, m.index).split('\n').length;
      out.push({ file, line, words, text });
    }
  }
  return out;
}

/** Entries declared with no tier helper are a structural miss the copy
 *  module makes impossible; this counts how many tiered entries a file has,
 *  so an empty catalog is reported rather than passing vacuously. */
export function tieredEntries(source) {
  return [...source.matchAll(ENTRY)].length;
}
