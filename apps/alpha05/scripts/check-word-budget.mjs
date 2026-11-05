#!/usr/bin/env node
/**
 * RB-TIERS typecheck-time guard: every inline tier-B sentence in the copy
 * catalog (src/content/**) is within TIER_B_WORD_BUDGET words. Tier A is
 * exempt by design, so long text has exactly one legal home. Run by
 * `pnpm --filter @vaipakam/alpha05 typecheck`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_B_WORD_BUDGET, overBudget, tieredEntries } from './wordBudget.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content');

// The budget constant lives in two files (an ESM script cannot import the
// app's TypeScript); refuse to run if they disagree.
const tiersSrc = fs.readFileSync(path.join(root, 'src', 'shared', 'copy', 'tiers.ts'), 'utf8');
const declared = /TIER_B_WORD_BUDGET\s*=\s*(\d+)/.exec(tiersSrc);
if (!declared || Number(declared[1]) !== TIER_B_WORD_BUDGET) {
  console.error(`[word-budget] TIER_B_WORD_BUDGET differs: scripts/wordBudget.mjs=${TIER_B_WORD_BUDGET}, src/shared/copy/tiers.ts=${declared?.[1] ?? 'missing'}`);
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield p;
  }
}

let entries = 0;
const problems = [];
for (const file of walk(contentDir)) {
  const src = fs.readFileSync(file, 'utf8');
  entries += tieredEntries(src);
  problems.push(...overBudget(src, path.relative(root, file)));
}

if (entries === 0) {
  console.error('[word-budget] no tiered copy entries found under src/content; the catalog must declare copy through A()/B()/C().');
  process.exit(1);
}
if (problems.length > 0) {
  for (const p of problems) {
    console.error(`${p.file}:${p.line}: tier-B sentence is ${p.words} words (budget ${TIER_B_WORD_BUDGET}); move the mechanism to a tier-C entry or tag it tier A if it is a consent or consequence.\n    "${p.text}"`);
  }
  process.exit(1);
}
console.log(`[word-budget] ${entries} tiered entries, every tier-B sentence within ${TIER_B_WORD_BUDGET} words.`);
