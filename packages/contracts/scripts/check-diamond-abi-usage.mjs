#!/usr/bin/env node
/**
 * Every function name a consumer sends to the Diamond through the GENERATED
 * combined ABI (`diamondAbi.json`, exported as `DIAMOND_ABI` /
 * `DIAMOND_ABI_VIEM`) must be a function that ABI still carries.
 *
 * Why it exists (#3318 Codex r2 P1): a facet change removed `ownerOf` from the
 * Diamond, and one reader still asked for it. viem throws
 * `AbiFunctionNotFoundError` before any request, so the read fails on every
 * chain, yet the unit tests passed because their fake clients never check ABI
 * membership. The generated ABI is JSON and cannot be typed `as const`, so
 * tsc cannot see it either; this scan is the guard.
 *
 * It reads source as TEXT and recognises three shapes, each with a literal
 * function name:
 *   1. an object literal carrying `abi: DIAMOND_ABI` or `abi: DIAMOND_ABI_VIEM`
 *      and `functionName: '<name>'`;
 *   2. the app's `write('<name>', …)` from `useDiamondWrite()`, unless the call
 *      passes `target:` (a write sent to another contract or ABI);
 *   3. a local helper whose parameter is `functionName` and whose body sends
 *      to the Diamond ABI (the live drivers' `read(...)`), called as
 *      `<helper>('<name>', …)`.
 * A name held in a variable is not checked. Usage:
 *   node packages/contracts/scripts/check-diamond-abi-usage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
const ROOTS = ['apps/app', 'apps/alpha05', 'apps/indexer', 'apps/keeper', 'apps/agent', 'packages/lib/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.wrangler', 'coverage', 'playwright-report', 'test-results']);
const EXT = /\.(ts|tsx|mjs|js)$/;
const ABI_KEY = /\babi\s*:\s*(DIAMOND_ABI_VIEM|DIAMOND_ABI)\b/g;
const ABI_KEY_ONE = /\babi\s*:\s*(DIAMOND_ABI_VIEM|DIAMOND_ABI)\b/;
const NAME = '([A-Za-z_$][\\w$]*)';

/** Function names the generated Diamond ABI carries. */
export function diamondFunctionNames(abiPath = path.join(REPO, 'packages/contracts/src/diamondAbi.json')) {
  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
  return new Set(abi.filter((e) => e.type === 'function').map((e) => e.name));
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

/** Every literal Diamond function name `src` uses, with its line. */
export function namesUsed(src) {
  const out = [];
  for (const m of src.matchAll(ABI_KEY)) {
    const obj = enclosingObject(src, m.index);
    if (!obj) continue;
    const fn = obj.match(new RegExp(`\\bfunctionName\\s*:\\s*['"\`]${NAME}['"\`]`));
    if (fn) out.push({ name: fn[1], line: lineOf(src, m.index), shape: 'abi object' });
  }
  if (/\buseDiamondWrite\s*\(/.test(src)) {
    for (const m of src.matchAll(new RegExp(`\\bwrite\\s*\\(\\s*['"\`]${NAME}['"\`]`, 'g'))) {
      const open = src.indexOf('(', m.index);
      if (/\btarget\s*:/.test(callArgs(src, open))) continue;
      out.push({ name: m[1], line: lineOf(src, m.index), shape: 'useDiamondWrite' });
    }
  }
  const helpers = new Set();
  const defs = [
    new RegExp(`\\b(?:const|let)\\s+${NAME}\\s*=\\s*(?:async\\s*)?\\(\\s*functionName\\b`, 'g'),
    new RegExp(`\\bfunction\\s+${NAME}\\s*\\(\\s*functionName\\b`, 'g'),
  ];
  for (const re of defs) {
    for (const m of src.matchAll(re)) {
      if (ABI_KEY_ONE.test(src.slice(m.index, m.index + 400))) helpers.add(m[1]);
    }
  }
  for (const h of helpers) {
    const re = new RegExp(`(?<![\\w$.])${h.replace(/\$/g, '\\$')}\\s*\\(\\s*['"\`]${NAME}['"\`]`, 'g');
    for (const m of src.matchAll(re)) out.push({ name: m[1], line: lineOf(src, m.index), shape: `helper ${h}` });
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

/** Every use of a name the Diamond ABI does not carry. */
export function findViolations(repo = REPO, names = diamondFunctionNames()) {
  const bad = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(repo, root))) {
      for (const u of namesUsed(fs.readFileSync(file, 'utf8'))) {
        if (!names.has(u.name)) bad.push({ file: path.relative(repo, file), ...u });
      }
    }
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bad = findViolations();
  if (bad.length) {
    for (const b of bad) console.error(`${b.file}:${b.line}: '${b.name}' is not a Diamond function (${b.shape})`);
    console.error(`check-diamond-abi-usage: ${bad.length} use(s) of a function the generated Diamond ABI does not carry.`);
    process.exit(1);
  }
  console.log('check-diamond-abi-usage: every literal Diamond function name is in diamondAbi.json');
}
