#!/usr/bin/env node
/**
 * Build the combined Diamond ABI (`src/diamondAbi.json`) from the per-facet
 * ABIs in `src/abis/` (UX3-008, 2026-10-03 live review).
 *
 * Why this exists. `DIAMOND_ABI` used to be every facet's ABI spread into one
 * array at module load. Each facet's ABI carries the shared error and event
 * definitions it can surface, so the same entries were repeated across 80
 * facets: about 2.15 MB of the 2.8 MB "contract-abis" chunk that every
 * connected session downloads was exact duplicates. Removing an EXACT
 * duplicate cannot change what the ABI encodes or decodes — the entry it
 * removes is byte-for-byte the one it keeps — so the union is the same ABI
 * at a quarter of the size.
 *
 * The facet list is `diamond-facets.json`, the single source. Entries are
 * compared on a canonical form (keys sorted, recursively), and the FIRST
 * occurrence is kept, so the union's order follows the manifest's.
 *
 * Run by `contracts/script/exportFrontendAbis.sh` after every ABI export.
 * `build-diamond-abi.test.mjs` fails CI when the committed union is stale.
 *
 * Usage: node packages/contracts/scripts/build-diamond-abi.mjs [--check]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = join(HERE, '..');
export const ABI_DIR = join(PKG_DIR, 'src', 'abis');
export const UNION_PATH = join(PKG_DIR, 'src', 'diamondAbi.json');
export const MANIFEST_PATH = join(HERE, 'diamond-facets.json');

/** JSON with object keys sorted at every depth — the identity two ABI
 *  entries share exactly when they are the same entry. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readFacetAbi(name, dir = ABI_DIR) {
  const parsed = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  const abi = Array.isArray(parsed) ? parsed : parsed.abi;
  if (!Array.isArray(abi)) throw new Error(`${name}.json is not an ABI array`);
  return abi;
}

/** The union of the listed facets' ABIs, exact duplicates removed, first
 *  occurrence kept. */
export function buildDiamondAbi(facets, read = readFacetAbi) {
  const seen = new Set();
  const out = [];
  for (const name of facets) {
    for (const entry of read(name)) {
      const key = canonical(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/** One entry per line: small enough to ship, still reviewable as a diff. */
export function serialize(abi) {
  return `[\n${abi.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`;
}

/** Every ABI JSON in the directory (metadata files excluded). */
export function listAbiFiles(dir = ABI_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { facets } = readManifest();
  const text = serialize(buildDiamondAbi(facets));
  if (process.argv.includes('--check')) {
    const current = readFileSync(UNION_PATH, 'utf8');
    if (current !== text) {
      console.error('src/diamondAbi.json is stale — run node packages/contracts/scripts/build-diamond-abi.mjs');
      process.exit(1);
    }
    console.log('src/diamondAbi.json is current');
  } else {
    writeFileSync(UNION_PATH, text);
    console.log(`wrote ${UNION_PATH}`);
  }
}
