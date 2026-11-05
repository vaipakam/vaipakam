#!/usr/bin/env node
/**
 * The mesh watcher's ABI subset: the compiled facet ABIs, cut down to the
 * views this Worker reads.
 *
 * WHY. `src/abi.ts` used to import five COMPLETE per-facet ABI files from
 * `packages/contracts/src/abis/`, about 300 KB of the Worker's 1.1 MB
 * bundle and nearly all of it error and event entries the watcher never
 * decodes. Every cold start parsed all of it, and viem searched those
 * arrays on every call. The watcher runs on a 5-minute cron on the Workers
 * Free plan (10 ms CPU), and most firings meet a cold isolate, so that cost
 * landed on nearly every tick.
 *
 * WHAT STAYS THE SAME. Every entry in `src/abiSubset.json` is copied
 * VERBATIM from the compiled facet ABI. Nothing is hand-typed: the Solidity
 * compiler is still the only source of each decode shape (CLAUDE.md,
 * "Worker ABI consumption"). `assertAbiShape()` still runs before every
 * tick, against the subset.
 *
 * WHAT THIS SCRIPT ADDS. The subset is a second copy, and a copy can go
 * stale. `--check` (the default) refuses a subset whose entry differs in
 * ANY way from the function of that name in today's compiled ABI, or whose
 * function is missing or overloaded there. It runs in CI (the mesh-watcher
 * job, path-triggered by any change under `packages/contracts/src/abis/`)
 * and in `npm run build` and `npm run deploy`, so a stale subset cannot
 * reach the Worker by either route. Before this change a re-export that
 * moved a watched shape failed the first live tick; now it fails before
 * the deploy.
 *
 * Usage (from ops/mesh-watcher):
 *   node scripts/abi-subset.mjs            # --check: exit 1 on any drift
 *   node scripts/abi-subset.mjs --write    # re-copy every listed view
 *   node scripts/abi-subset.mjs --write --add RepatriationFacet:getFoo
 *
 * The subset is self-describing: `--write` re-copies the views already
 * listed, and `--add Facet:function` lists a new one. Which views the
 * READERS expect is `src/abi.ts`'s `EXPECTED_VIEWS`; the unit test
 * `test/abiSubset.test.ts` holds the subset's list equal to that.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSET_PATH = join(HERE, '..', 'src', 'abiSubset.json');
const ABI_DIR = join(HERE, '..', '..', '..', 'packages', 'contracts', 'src', 'abis');

/** Load the compiled ABI of `facet` (a file name under packages/contracts/src/abis). */
function loadCompiled(facet) {
  if (!/^[A-Za-z0-9]+$/.test(facet)) throw new Error(`not a facet name: ${facet}`);
  return JSON.parse(readFileSync(join(ABI_DIR, `${facet}.json`), 'utf8'));
}

/** The single compiled function entry `name` in `abi`, or a problem string. */
function compiledFunction(abi, facet, name) {
  const matches = abi.filter((e) => e.type === 'function' && e.name === name);
  if (matches.length === 0) return { problem: `${facet}.${name}: missing from the compiled ABI` };
  if (matches.length > 1) {
    return { problem: `${facet}.${name}: ${matches.length} overloads in the compiled ABI, expected exactly 1` };
  }
  return { entry: matches[0] };
}

/** Key-order-independent JSON, so the check compares content, not layout. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Every way `subset` differs from the compiled ABIs. Empty = in sync. */
export function subsetProblems(subset) {
  const problems = [];
  for (const [facet, entries] of Object.entries(subset)) {
    let compiled;
    try {
      compiled = loadCompiled(facet);
    } catch (e) {
      problems.push(`${facet}: cannot read its compiled ABI (${e.message})`);
      continue;
    }
    const seen = new Set();
    for (const entry of entries) {
      if (entry.type !== 'function') {
        problems.push(`${facet}: the subset carries a non-function entry (${entry.type}); it holds views only`);
        continue;
      }
      if (seen.has(entry.name)) problems.push(`${facet}.${entry.name}: listed twice in the subset`);
      seen.add(entry.name);
      const found = compiledFunction(compiled, facet, entry.name);
      if (found.problem) {
        problems.push(found.problem);
      } else if (canonical(found.entry) !== canonical(entry)) {
        problems.push(`${facet}.${entry.name}: differs from the compiled ABI`);
      }
    }
  }
  return problems;
}

function main(argv) {
  const write = argv.includes('--write');
  const adds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--add') adds.push(argv[++i] ?? '');
  }
  if (adds.length > 0 && !write) {
    console.error('--add needs --write');
    return 2;
  }

  const subset = JSON.parse(readFileSync(SUBSET_PATH, 'utf8'));

  if (!write) {
    const problems = subsetProblems(subset);
    if (problems.length > 0) {
      console.error(
        'mesh-watcher ABI subset is out of date with packages/contracts/src/abis.\n' +
          'Run `npm run abi:write` in ops/mesh-watcher, then re-check the readers in\n' +
          'src/mesh.ts against any view whose shape moved (assertAbiShape names them).\n  ' +
          problems.join('\n  '),
      );
      return 1;
    }
    const n = Object.values(subset).reduce((a, e) => a + e.length, 0);
    console.log(`mesh-watcher ABI subset: ${n} views match the compiled facet ABIs.`);
    return 0;
  }

  for (const spec of adds) {
    const [facet, name] = spec.split(':');
    if (!facet || !name) {
      console.error(`--add expects Facet:function, got "${spec}"`);
      return 2;
    }
    subset[facet] ??= [];
    if (!subset[facet].some((e) => e.name === name)) subset[facet].push({ type: 'function', name });
  }

  const problems = [];
  const next = {};
  for (const facet of Object.keys(subset).sort()) {
    const compiled = loadCompiled(facet);
    next[facet] = subset[facet].map((e) => {
      const found = compiledFunction(compiled, facet, e.name);
      if (found.problem) {
        problems.push(found.problem);
        return e;
      }
      return found.entry;
    });
  }
  if (problems.length > 0) {
    console.error(`Nothing written:\n  ${problems.join('\n  ')}`);
    return 1;
  }
  writeFileSync(SUBSET_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${SUBSET_PATH}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
