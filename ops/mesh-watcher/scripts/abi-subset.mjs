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
 * EVENTS TOO (#3239, #3237). The event-alert pass (`src/eventAlerts.ts`)
 * decodes events from the sanctions list, the delisting timelock and the
 * governance timelock, so the subset also carries `event` entries, copied
 * and checked exactly like the views. An entry is identified by its TYPE and
 * name together, so a view and an event of the same name never shadow each
 * other. The same pass also carries the state-changing functions it DECODES
 * a queued governance call against (#3237); those are `function` entries too,
 * checked the same way, and never called.
 *
 * Usage (from ops/mesh-watcher):
 *   node scripts/abi-subset.mjs            # --check: exit 1 on any drift
 *   node scripts/abi-subset.mjs --write    # re-copy every listed entry
 *   node scripts/abi-subset.mjs --write --add RepatriationFacet:getFoo
 *   node scripts/abi-subset.mjs --write --add SanctionsList:event:ListUpdated
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

/** The entry types the subset may carry. */
const ENTRY_TYPES = new Set(['function', 'event']);

/** The single compiled entry of `type` named `name` in `abi`, or a problem string. */
function compiledEntry(abi, facet, type, name) {
  const label = type === 'function' ? `${facet}.${name}` : `${facet}.${type}:${name}`;
  const matches = abi.filter((e) => e.type === type && e.name === name);
  if (matches.length === 0) return { problem: `${label}: missing from the compiled ABI` };
  if (matches.length > 1) {
    return { problem: `${label}: ${matches.length} overloads in the compiled ABI, expected exactly 1` };
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
      if (!ENTRY_TYPES.has(entry.type)) {
        problems.push(`${facet}: the subset carries a ${entry.type} entry; it holds functions and events only`);
        continue;
      }
      const id = `${entry.type}:${entry.name}`;
      if (seen.has(id)) problems.push(`${facet}.${id}: listed twice in the subset`);
      seen.add(id);
      const found = compiledEntry(compiled, facet, entry.type, entry.name);
      if (found.problem) {
        problems.push(found.problem);
      } else if (canonical(found.entry) !== canonical(entry)) {
        problems.push(`${facet}.${id}: differs from the compiled ABI`);
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
    console.log(`mesh-watcher ABI subset: ${n} entries match the compiled ABIs.`);
    return 0;
  }

  for (const spec of adds) {
    const parts = spec.split(':');
    const [facet, type, name] =
      parts.length === 2 ? [parts[0], 'function', parts[1]] : [parts[0], parts[1], parts[2]];
    if (!facet || !name || !ENTRY_TYPES.has(type) || parts.length > 3) {
      console.error(`--add expects Facet:function or Facet:event:Name, got "${spec}"`);
      return 2;
    }
    subset[facet] ??= [];
    if (!subset[facet].some((e) => e.type === type && e.name === name)) subset[facet].push({ type, name });
  }

  const problems = [];
  const next = {};
  for (const facet of Object.keys(subset).sort()) {
    const compiled = loadCompiled(facet);
    next[facet] = subset[facet].map((e) => {
      const found = compiledEntry(compiled, facet, e.type, e.name);
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
