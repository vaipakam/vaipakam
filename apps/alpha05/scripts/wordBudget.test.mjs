import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_B_WORD_BUDGET, overBudget, tieredEntries, wordCount } from './wordBudget.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('word budget rule', () => {
  it('matches the budget the app declares', () => {
    const src = fs.readFileSync(path.join(here, '..', 'src', 'shared', 'copy', 'tiers.ts'), 'utf8');
    expect(Number(/TIER_B_WORD_BUDGET\s*=\s*(\d+)/.exec(src)[1])).toBe(TIER_B_WORD_BUDGET);
  });
  it('counts words across whitespace', () => {
    expect(wordCount('  Due in   28 days ')).toBe(4);
  });
  it('reports only tier B entries over budget', () => {
    const long = Array.from({ length: TIER_B_WORD_BUDGET + 1 }, (_, i) => `w${i}`).join(' ');
    const src = `x = { a: A('${long}'), b: B('${long}'), c: C("${long}"), ok: B('short one') }`;
    const out = overBudget(src, 'f.ts');
    expect(out).toHaveLength(1);
    expect(out[0].words).toBe(TIER_B_WORD_BUDGET + 1);
    expect(tieredEntries(src)).toBe(4);
  });
  it('handles escaped quotes inside an entry', () => {
    const src = `B('it\\'s fine')`;
    expect(overBudget(src, 'f.ts')).toHaveLength(0);
    expect(tieredEntries(src)).toBe(1);
  });
});
