/**
 * UX3-008 — the combined Diamond ABI is a derived artifact. These checks are
 * what keep it honest: it must be current, it must be built from EVERY facet,
 * and it must lose nothing but exact duplicates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UNION_PATH,
  buildDiamondAbi,
  canonical,
  listAbiFiles,
  readFacetAbi,
  readManifest,
  serialize,
} from './build-diamond-abi.mjs';

const manifest = readManifest();

test('the committed union is current with the facet ABIs', () => {
  assert.equal(
    readFileSync(UNION_PATH, 'utf8'),
    serialize(buildDiamondAbi(manifest.facets)),
    'src/diamondAbi.json is stale — run node packages/contracts/scripts/build-diamond-abi.mjs',
  );
});

test('every ABI in src/abis is named exactly once, as a facet or as standalone', () => {
  const named = [...manifest.facets, ...manifest.standalone];
  assert.equal(new Set(named).size, named.length, 'a name appears twice in diamond-facets.json');
  const files = listAbiFiles();
  const missing = files.filter((f) => !named.includes(f));
  const stale = named.filter((n) => !files.includes(n));
  assert.deepEqual(missing, [], `ABI files not classified in diamond-facets.json: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `diamond-facets.json names ABIs that do not exist: ${stale.join(', ')}`);
});

test('the union drops only exact duplicates — every facet entry is still in it', () => {
  const union = new Set(JSON.parse(readFileSync(UNION_PATH, 'utf8')).map(canonical));
  for (const name of manifest.facets) {
    for (const entry of readFacetAbi(name)) {
      assert.ok(union.has(canonical(entry)), `${name}: ${entry.type} ${entry.name ?? ''} is missing from the union`);
    }
  }
});

test('the union holds nothing that no facet carries', () => {
  const facetEntries = new Set(manifest.facets.flatMap((n) => readFacetAbi(n).map(canonical)));
  for (const entry of JSON.parse(readFileSync(UNION_PATH, 'utf8'))) {
    assert.ok(facetEntries.has(canonical(entry)), `${entry.type} ${entry.name ?? ''} is not from any facet`);
  }
});

test('canonical form ignores key order and nothing else', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
  assert.notEqual(canonical({ inputs: [{ name: 'x' }] }), canonical({ inputs: [{ name: 'y' }] }));
});

test('first occurrence wins, so order follows the manifest', () => {
  const abis = {
    A: [{ type: 'error', name: 'E', inputs: [] }, { type: 'function', name: 'a', inputs: [] }],
    B: [{ inputs: [], name: 'E', type: 'error' }, { type: 'function', name: 'b', inputs: [] }],
  };
  const out = buildDiamondAbi(['A', 'B'], (n) => abis[n]);
  assert.deepEqual(out.map((e) => e.name), ['E', 'a', 'b']);
});
