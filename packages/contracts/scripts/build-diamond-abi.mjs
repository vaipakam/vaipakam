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
 * The PROXY's own declarations (#2399). One revert is raised by the Diamond
 * contract itself rather than by any facet: `VaipakamDiamond`'s fallback
 * reverts `FunctionDoesNotExist()` for an unrouted selector — exactly what a
 * stale ABI or a partial refresh produces, and the one revert a caller most
 * needs to be able to name. The manifest lists the proxy under `proxy`, and
 * the union takes only its ERRORS and EVENTS: its constructor is not part of
 * the deployed interface, and its `fallback` / `receive` entries would tell
 * an ABI consumer the Diamond accepts arbitrary calldata and plain ETH, which
 * is a statement about routing, not an entry point anyone should encode.
 *
 * Run by `contracts/script/exportFrontendAbis.sh` against its STAGED facet
 * ABIs, before anything is published (#2392 r1): a failure here leaves the
 * committed bundle untouched. Every run first checks that each ABI file is
 * classified exactly once in the manifest and that every manifest name
 * exists, so a facet exported but left out of the manifest fails the export
 * itself, not only the package test. `build-diamond-abi.test.mjs` fails CI
 * when the committed union is stale.
 *
 * Usage: node packages/contracts/scripts/build-diamond-abi.mjs
 *          [--check] [--abi-dir <dir>] [--out <file>]
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

/** The kinds of proxy entry the union takes (#2399). */
export const PROXY_ENTRY_TYPES = new Set(['error', 'event']);

/** The entries of a proxy ABI that belong in the union. */
export const proxyEntries = (abi) => abi.filter((e) => PROXY_ENTRY_TYPES.has(e.type));

/** The union of the listed facets' ABIs plus the proxies' errors and events,
 *  exact duplicates removed, first occurrence kept. */
export function buildDiamondAbi(facets, read = readFacetAbi, proxies = []) {
  const seen = new Set();
  const out = [];
  const add = (entries) => {
    for (const entry of entries) {
      const key = canonical(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  };
  for (const name of facets) add(read(name));
  for (const name of proxies) add(proxyEntries(read(name)));
  return out;
}

/** The union `diamond-facets.json` describes. */
export const buildFromManifest = (manifest, read = readFacetAbi) =>
  buildDiamondAbi(manifest.facets, read, manifest.proxy ?? []);

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

/** Every ABI file classified exactly once, every manifest name present.
 *  Returns the problems found; an empty list means the manifest and the
 *  directory agree. Shared by the generator and the package test, so the
 *  export and CI apply one rule. */
export function classificationProblems(manifest, files) {
  const named = [...manifest.facets, ...(manifest.proxy ?? []), ...(manifest.standalone ?? [])];
  const problems = [];
  const dupes = named.filter((n, i) => named.indexOf(n) !== i);
  if (dupes.length) problems.push(`named twice in diamond-facets.json: ${[...new Set(dupes)].join(', ')}`);
  const missing = files.filter((f) => !named.includes(f));
  if (missing.length) problems.push(`ABI files not classified in diamond-facets.json: ${missing.join(', ')}`);
  const stale = named.filter((n) => !files.includes(n));
  if (stale.length) problems.push(`diamond-facets.json names ABIs that do not exist: ${stale.join(', ')}`);
  return problems;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = readManifest();
  const abiDir = argValue('--abi-dir') ?? ABI_DIR;
  const outPath = argValue('--out') ?? UNION_PATH;
  const problems = classificationProblems(manifest, listAbiFiles(abiDir));
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const text = serialize(buildFromManifest(manifest, (n) => readFacetAbi(n, abiDir)));
  if (process.argv.includes('--check')) {
    const current = readFileSync(outPath, 'utf8');
    if (current !== text) {
      console.error('src/diamondAbi.json is stale — run node packages/contracts/scripts/build-diamond-abi.mjs');
      process.exit(1);
    }
    console.log('src/diamondAbi.json is current');
  } else {
    writeFileSync(outPath, text);
    console.log(`wrote ${outPath}`);
  }
}
