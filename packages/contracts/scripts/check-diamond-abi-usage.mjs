#!/usr/bin/env node
/**
 * Every function name a consumer sends through one of the GENERATED ABIs (the
 * combined Diamond ABI, `DIAMOND_ABI` / `DIAMOND_ABI_VIEM`, or a per-facet
 * `<Facet>ABI` from `@vaipakam/contracts/abis`) must be a function that ABI
 * still carries.
 *
 * Why it exists (#3318 Codex r2 P1 and the anvil-tier failures): a facet
 * change removed the Diamond's ERC-721 surface, and readers still asked for
 * `ownerOf` / `positionLock` / `transferFrom` through these ABIs. viem throws
 * `AbiFunctionNotFoundError` before any request, yet the unit tests passed:
 * their fake clients never check ABI membership. The ABIs are JSON and cannot
 * be typed `as const`, so tsc cannot see it either; this scan is the guard.
 *
 * It reads source as TEXT. An "ABI reference" is `DIAMOND_ABI_VIEM`,
 * `DIAMOND_ABI`, any `<Name>ABI` with a `src/abis/<Name>.json`, or a local
 * alias of one (`const NFT = VaipakamNFTFacetABI as Abi`). It checks, for a
 * literal function name:
 *   1. an object literal with `abi: <ref>` and `functionName: '<name>'`;
 *   2. a call that passes `<ref>, '<name>'` as consecutive arguments (a
 *      `read(NFT, 'ownerOf', …)` helper);
 *   3. a local helper whose parameter is `functionName` and whose body uses a
 *      ref (`const read = (functionName, …) => …abi: DIAMOND_ABI…`), called
 *      as `<helper>('<name>', …)`;
 *   4. the app's `write('<name>', …)` from `useDiamondWrite()` (combined ABI),
 *      unless the call passes `target:`;
 *   5. the anvil harness: `.diamondWrite(<who>, '<name>', …)` and, in a file
 *      that drives a scenario, `.read('<name>', …)` (both the combined ABI).
 * A name held in a variable is not checked. Usage:
 *   node packages/contracts/scripts/check-diamond-abi-usage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
const ROOTS = [
  'apps/app',
  'apps/alpha05',
  'apps/indexer',
  'apps/keeper',
  'apps/agent',
  'packages/lib/src',
  'packages/anvil-harness',
  'packages/protocol-e2e',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.wrangler', 'coverage', 'playwright-report', 'test-results']);
const EXT = /\.(ts|tsx|mjs|js)$/;
const NAME = '([A-Za-z_$][\\w$]*)';
const LIT = `['"\`]${NAME}['"\`]`;

const fnNames = (abi) => new Set(abi.filter((e) => e.type === 'function').map((e) => e.name));

/** ABI reference name → the function names it carries. */
export function generatedAbis(repo = REPO) {
  const dir = path.join(repo, 'packages/contracts/src/abis');
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const abi = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(abi)) out.set(`${f.slice(0, -5)}ABI`, fnNames(abi));
  }
  const diamond = fnNames(JSON.parse(fs.readFileSync(path.join(repo, 'packages/contracts/src/diamondAbi.json'), 'utf8')));
  out.set('DIAMOND_ABI', diamond);
  out.set('DIAMOND_ABI_VIEM', diamond);
  return out;
}

/** The text of the innermost `{…}` around `index`, or null. */
function enclosingObject(src, index) {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i -= 1) {
    const c = src[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** The argument text of the call whose `(` is at `open`. */
function callArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;
/** Full regular-expression escape of `s` (every metacharacter, not just `$`). */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every literal function name `src` sends through a generated ABI, as
 *  `{ name, abi, line, shape }`, `abi` being the reference it resolves to. */
export function namesUsed(src, abis = generatedAbis()) {
  // Local aliases of a generated ABI.
  const refs = new Map([...abis.keys()].map((k) => [k, k]));
  for (const m of src.matchAll(new RegExp(`\\b(?:const|let)\\s+${NAME}\\s*(?::[^=]+)?=\\s*${NAME}\\b`, 'g'))) {
    if (abis.has(m[2])) refs.set(m[1], m[2]);
  }
  const refAlt = [...refs.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
  const out = [];
  const push = (name, ref, index, shape) => out.push({ name, abi: refs.get(ref) ?? ref, line: lineOf(src, index), shape });

  // 1. object literal
  for (const m of src.matchAll(new RegExp(`\\babi\\s*:\\s*(${refAlt})\\b(?!\\s*\\.)`, 'g'))) {
    const obj = enclosingObject(src, m.index);
    const fn = obj && obj.match(new RegExp(`\\bfunctionName\\s*:\\s*${LIT}`));
    if (fn) push(fn[1], m[1], m.index, 'abi object');
  }
  // 2. `<ref>, '<name>'` as consecutive call arguments
  for (const m of src.matchAll(new RegExp(`[(,]\\s*(${refAlt})\\s*,\\s*${LIT}`, 'g'))) {
    push(m[2], m[1], m.index, 'abi argument');
  }
  // 3. a helper bound to a ref by its `functionName` parameter
  const helpers = new Map();
  for (const re of [
    new RegExp(`\\b(?:const|let)\\s+${NAME}\\s*=\\s*(?:async\\s*)?(?:<[^>]*>)?\\(\\s*functionName\\b`, 'g'),
    new RegExp(`\\bfunction\\s+${NAME}\\s*(?:<[^>]*>)?\\(\\s*functionName\\b`, 'g'),
  ]) {
    for (const m of src.matchAll(re)) {
      const ref = src.slice(m.index, m.index + 400).match(new RegExp(`\\babi\\s*:\\s*(${refAlt})\\b`));
      if (ref) helpers.set(m[1], ref[1]);
    }
  }
  for (const [h, ref] of helpers) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc(h)}\\s*(?:<[^>]*>)?\\(\\s*${LIT}`, 'g'))) {
      push(m[1], ref, m.index, `helper ${h}`);
    }
  }
  // 4. the app's diamond write hook
  if (/\buseDiamondWrite\s*\(/.test(src)) {
    for (const m of src.matchAll(new RegExp(`\\bwrite\\s*\\(\\s*${LIT}`, 'g'))) {
      if (/\btarget\s*:/.test(callArgs(src, src.indexOf('(', m.index)))) continue;
      push(m[1], 'DIAMOND_ABI_VIEM', m.index, 'useDiamondWrite');
    }
  }
  // 5. the anvil harness (combined ABI)
  for (const m of src.matchAll(new RegExp(`\\.diamondWrite\\s*\\(\\s*[^,()]+,\\s*${LIT}`, 'g'))) {
    push(m[1], 'DIAMOND_ABI_VIEM', m.index, 'harness diamondWrite');
  }
  if (/\bscenario\s*\(|anvil-harness/.test(src)) {
    for (const m of src.matchAll(new RegExp(`\\b(?:sc|scenario\\(\\))\\.read\\s*(?:<[^>]*>)?\\(\\s*${LIT}`, 'g'))) {
      push(m[1], 'DIAMOND_ABI_VIEM', m.index, 'harness read');
    }
  }
  return out;
}

function* sourceFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(path.join(dir, e.name));
    } else if (EXT.test(e.name) && !e.name.endsWith('.d.ts')) yield path.join(dir, e.name);
  }
}

/** Every use of a name its ABI does not carry. */
export function findViolations(repo = REPO, abis = generatedAbis(repo)) {
  const bad = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(repo, root))) {
      for (const u of namesUsed(fs.readFileSync(file, 'utf8'), abis)) {
        if (!abis.get(u.abi)?.has(u.name)) bad.push({ file: path.relative(repo, file), ...u });
      }
    }
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bad = findViolations();
  if (bad.length) {
    for (const b of bad) console.error(`${b.file}:${b.line}: '${b.name}' is not in ${b.abi} (${b.shape})`);
    console.error(`check-diamond-abi-usage: ${bad.length} use(s) of a function a generated ABI does not carry.`);
    process.exit(1);
  }
  console.log('check-diamond-abi-usage: every literal function name sent through a generated ABI is in it');
}
