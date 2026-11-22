#!/usr/bin/env node
/**
 * Build the error catalogue (#3916, RefactorRulesDesign §7.4).
 *
 * One catalogue lists every error of every contract the platform ships, and
 * every reader (the shared decoder the apps use, the keeper, the indexer, the
 * transaction explainer, support) reads it. It is built from three inputs:
 *
 *   1. The compiled interfaces: every ABI named in `diamond-facets.json`
 *      (facets, the Diamond proxy, standalone contracts). These give each
 *      error's name, selector and values.
 *   2. `src/errorRaisers.json`: every entry function whose reachable code can
 *      raise each error, derived from the compiler's AST by
 *      `contracts/script/error-raisers.mjs` (it needs forge, so it is
 *      committed and checked in the pre-deploy gate).
 *   3. `errors/meanings.json`, written by hand: what each error means in plain
 *      words, who can act on it (the user, an operator, nobody), and whether
 *      it is internal ("this should be impossible": the apps show it as a
 *      fault of the platform, never as something the user did).
 *
 * Output, both generated, never edited by hand:
 *   - `src/errorCatalogue.json`: one row per error, keyed by selector, with
 *     the meaning merged in. Small enough for the apps to ship.
 *     A row's `source` is `platform` (an exported interface declares it),
 *     `reached` (only a contract the platform deploys without exporting its
 *     interface raises it; the AST gave its declaration) or `builtin`
 *     (`Error(string)`, `Panic(uint256)`).
 *   - `src/errorRaisers.json` stays a file of its own: it is about 0.9 MB, and
 *     only tools read it (`@vaipakam/contracts/error-raisers`).
 *
 * The checks (each a problem that fails the build and the package test):
 *   - two different errors share a 4-byte selector;
 *   - a meaning names no error the platform ships (a stale entry);
 *   - a meaning is malformed (actor outside the three, empty message);
 *   - `shownByName` names an error that has a meaning, or none that exists;
 *   - a raiser's selector is not in the catalogue;
 *   - more platform errors have no meaning than `maxErrorsWithoutEntry`
 *     allows. The number may not rise until the refactor pass ends; when it
 *     falls, the file's number must be lowered to match, so it cannot creep
 *     back up.
 *
 * Usage: node packages/contracts/scripts/build-error-catalogue.mjs
 *          [--check] [--abi-dir <dir>] [--out <file>] [--raisers <file>]
 *   --check  compare with the committed catalogue instead of writing it
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector } from 'viem';
import { ABI_DIR, readManifest, readFacetAbi } from './build-diamond-abi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = join(HERE, '..');
export const CATALOGUE_PATH = join(PKG_DIR, 'src', 'errorCatalogue.json');
export const RAISERS_PATH = join(PKG_DIR, 'src', 'errorRaisers.json');
export const MEANINGS_PATH = join(PKG_DIR, 'errors', 'meanings.json');

export const ACTORS = new Set(['user', 'operator', 'nobody']);

/** Errors the EVM or Solidity raise without a declaration in any interface. */
export const BUILTINS = [
  { signature: 'Error(string)', inputs: [{ name: 'reason', type: 'string' }] },
  { signature: 'Panic(uint256)', inputs: [{ name: 'code', type: 'uint256' }] },
];

/** The key raisers use for a revert with no data (`revert()`, `require(c)`). */
export const EMPTY_REVERT = '0x';

/** `Name(type,...)`, with tuples expanded as the selector hashes them. */
export function abiType(p) {
  if (!p.type.startsWith('tuple')) return p.type;
  return `(${(p.components ?? []).map(abiType).join(',')})${p.type.slice('tuple'.length)}`;
}
export const errorSignature = (e) => `${e.name}(${e.inputs.map(abiType).join(',')})`;
const nameOf = (signature) => signature.slice(0, signature.indexOf('('));

/** The meanings file, parsed. */
export function readMeanings(path = MEANINGS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every platform error from the ABIs: selector → {signature, name, inputs}. */
export function platformErrors(manifest, abiDir = ABI_DIR) {
  const out = new Map();
  const problems = [];
  const names = [...manifest.facets, ...(manifest.proxy ?? []), ...(manifest.standalone ?? [])];
  for (const contract of names) {
    for (const e of readFacetAbi(contract, abiDir)) {
      if (e.type !== 'error') continue;
      const signature = errorSignature(e);
      const selector = toFunctionSelector(signature).toLowerCase();
      const seen = out.get(selector);
      if (seen && seen.signature !== signature) {
        problems.push(`selector ${selector} is shared by ${seen.signature} and ${signature}; the catalogue cannot tell them apart`);
        continue;
      }
      if (!seen) out.set(selector, { signature, name: e.name, inputs: e.inputs });
    }
  }
  return { errors: out, problems };
}

/**
 * The catalogue rows, the problems found, and the count of platform errors
 * with no meaning. Pure over its inputs.
 */
export function buildCatalogue({ errors, meanings, raisers: raisersFile }) {
  const problems = [];
  const raisers = raisersFile?.raisers ?? {};
  // Errors raised by a contract the platform deploys whose interface is not
  // exported (a swap adapter, a holder the Diamond deploys): the AST gave
  // their declaration, and the selector must hash from it.
  const reached = new Map();
  for (const [selector, d] of Object.entries(raisersFile?.declarations ?? {})) {
    if (toFunctionSelector(d.signature).toLowerCase() !== selector) {
      problems.push(`errorRaisers.json declares ${d.signature} under ${selector}, which is not its selector`);
      continue;
    }
    if (!errors.has(selector)) reached.set(selector, { signature: d.signature, name: nameOf(d.signature), inputs: d.inputs });
  }
  const entries = meanings.entries ?? {};
  const bySignature = new Map();
  const byName = new Map();
  for (const [selector, row] of [...errors, ...reached]) {
    bySignature.set(row.signature, selector);
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(selector);
  }
  const rows = new Map();
  for (const [selector, row] of errors) rows.set(selector, { ...row, source: 'platform' });
  for (const [selector, row] of reached) rows.set(selector, { ...row, source: 'reached' });
  for (const b of BUILTINS) {
    const selector = toFunctionSelector(b.signature).toLowerCase();
    if (!rows.has(selector)) rows.set(selector, { signature: b.signature, name: nameOf(b.signature), inputs: b.inputs, source: 'builtin' });
  }
  for (const b of BUILTINS) {
    const s = toFunctionSelector(b.signature).toLowerCase();
    bySignature.set(b.signature, s);
    if (!byName.has(nameOf(b.signature))) byName.set(nameOf(b.signature), [s]);
  }

  // A meaning keyed by a full signature applies to that error only; keyed by
  // a bare name, to every error of that name. A signature key wins.
  const applied = new Map(); // selector → [key, meaning]
  for (const [key, meaning] of Object.entries(entries)) {
    if (key.startsWith('_')) continue;
    if (!meaning || typeof meaning !== 'object') {
      problems.push(`meaning ${key}: not an object`);
      continue;
    }
    if (!ACTORS.has(meaning.actor)) problems.push(`meaning ${key}: actor must be one of ${[...ACTORS].join(', ')}`);
    if (typeof meaning.message !== 'string' || !meaning.message.trim()) problems.push(`meaning ${key}: message must be a non-empty string`);
    if (meaning.internal !== undefined && typeof meaning.internal !== 'boolean') problems.push(`meaning ${key}: internal must be true or false`);
    const extra = Object.keys(meaning).filter((k) => !['actor', 'message', 'internal'].includes(k));
    if (extra.length) problems.push(`meaning ${key}: unknown field(s) ${extra.join(', ')}`);
    const targets = key.includes('(') ? (bySignature.has(key) ? [bySignature.get(key)] : []) : byName.get(key) ?? [];
    if (!targets.length) {
      problems.push(`meaning ${key}: no error the platform ships has this ${key.includes('(') ? 'signature' : 'name'} (remove the entry, or fix its key)`);
      continue;
    }
    for (const selector of targets) {
      const prior = applied.get(selector);
      if (prior && prior[0].includes('(') && !key.includes('(')) continue;
      applied.set(selector, [key, meaning]);
    }
  }
  for (const [selector, [, meaning]] of applied) {
    const row = rows.get(selector);
    row.actor = meaning.actor;
    row.message = meaning.message;
    if (meaning.internal) row.internal = true;
  }

  const shown = meanings.shownByName ?? [];
  for (const name of shown) {
    const sels = byName.get(name);
    if (!sels) problems.push(`shownByName ${name}: no error the platform ships has this name`);
    else if (sels.some((s) => rows.get(s).message)) problems.push(`shownByName ${name}: it has a meaning now; remove it from shownByName`);
    else for (const s of sels) rows.get(s).shownByName = true;
  }

  for (const selector of Object.keys(raisers)) {
    if (selector !== EMPTY_REVERT && !rows.has(selector)) problems.push(`errorRaisers.json lists ${selector}, which no shipped interface declares (rebuild the raisers and the interfaces together)`);
  }

  const withoutEntry = [...rows.values()].filter((r) => r.source !== 'builtin' && !r.message).length;
  const max = meanings.maxErrorsWithoutEntry;
  if (!Number.isInteger(max)) problems.push('meanings.json: maxErrorsWithoutEntry must be a whole number');
  else if (withoutEntry > max) problems.push(`${withoutEntry} platform errors have no meaning, above the ${max} allowed: write a meaning for each new error (errors/meanings.json)`);
  else if (withoutEntry < max) problems.push(`${withoutEntry} platform errors have no meaning, fewer than the ${max} recorded: lower maxErrorsWithoutEntry to ${withoutEntry} so it cannot creep back up`);

  return { rows, problems, withoutEntry };
}

/** An ABI parameter without `internalType`. */
const slimParam = (p) => {
  const out = { name: p.name ?? '', type: p.type };
  if (p.components) out.components = p.components.map(slimParam);
  return out;
};

/** The catalogue file's text: rows sorted by selector, one per line. */
export function renderCatalogue(rows) {
  const lines = [...rows.keys()].sort().map((selector) => {
    const r = rows.get(selector);
    // Inputs keep the ABI's name, type and components; the Solidity-side
    // `internalType` is dropped (it decodes nothing and is a third of the file).
    const row = { signature: r.signature, name: r.name, inputs: r.inputs.map(slimParam), source: r.source };
    if (r.actor) row.actor = r.actor;
    if (r.message) row.message = r.message;
    if (r.internal) row.internal = true;
    if (r.shownByName) row.shownByName = true;
    return `    ${JSON.stringify(selector)}: ${JSON.stringify(row)}`;
  });
  const readme =
    'GENERATED by packages/contracts/scripts/build-error-catalogue.mjs from the shipped interfaces and errors/meanings.json. Do not edit: write meanings in errors/meanings.json and re-run. Which entry functions can raise each error is in errorRaisers.json.';
  return `{\n  "_readme": ${JSON.stringify(readme)},\n  "errors": {\n${lines.join(',\n')}\n  }\n}\n`;
}

export function main(argv = process.argv.slice(2)) {
  let check = false;
  let abiDir = ABI_DIR;
  let out = CATALOGUE_PATH;
  let raisersPath = RAISERS_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--abi-dir' && argv[i + 1]) abiDir = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out = argv[++i];
    else if (argv[i] === '--raisers' && argv[i + 1]) raisersPath = argv[++i];
    else {
      console.error(`build-error-catalogue: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  const { errors, problems } = platformErrors(readManifest(), abiDir);
  const raisers = JSON.parse(readFileSync(raisersPath, 'utf8'));
  const built = buildCatalogue({ errors, meanings: readMeanings(), raisers });
  problems.push(...built.problems);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const text = renderCatalogue(built.rows);
  if (check) {
    let committed = '';
    try {
      committed = readFileSync(out, 'utf8');
    } catch {
      /* missing reads as stale */
    }
    if (committed !== text) {
      console.error('  ✗ src/errorCatalogue.json is stale: run node packages/contracts/scripts/build-error-catalogue.mjs');
      return 1;
    }
    console.log(`  ✓ error catalogue current: ${built.rows.size} errors, ${built.withoutEntry} platform errors without a meaning`);
    return 0;
  }
  writeFileSync(out, text);
  console.log(`  ✓ error catalogue: ${built.rows.size} errors, ${built.withoutEntry} platform errors without a meaning -> ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
