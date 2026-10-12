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
  buildFromManifest,
  canonical,
  classificationProblems,
  listAbiFiles,
  readFacetAbi,
  proxyEntries,
  readManifest,
  serialize,
} from './build-diamond-abi.mjs';

const manifest = readManifest();

test('the committed union is current with the facet ABIs', () => {
  assert.equal(
    readFileSync(UNION_PATH, 'utf8'),
    serialize(buildFromManifest(manifest)),
    'src/diamondAbi.json is stale — run node packages/contracts/scripts/build-diamond-abi.mjs',
  );
});

test('every ABI in src/abis is named exactly once, as a facet, the proxy or standalone', () => {
  assert.deepEqual(classificationProblems(manifest, listAbiFiles()), []);
});

test('the classification rule names each kind of drift (#2392 r1)', () => {
  const m = { facets: ['A', 'B'], standalone: ['S'] };
  assert.deepEqual(classificationProblems(m, ['A', 'B', 'S']), []);
  // A facet exported but left out of the manifest — the case the export
  // must now refuse rather than silently omit from the union.
  assert.match(classificationProblems(m, ['A', 'B', 'S', 'New']).join('\n'), /not classified.*New/);
  assert.match(classificationProblems(m, ['A', 'S']).join('\n'), /do not exist.*B/);
  assert.match(
    classificationProblems({ facets: ['A', 'A'], standalone: [] }, ['A']).join('\n'),
    /named twice.*A/,
  );
  // The proxy class counts as a classification (#2399), and cannot double up.
  const withProxy = { ...m, proxy: ['P'] };
  assert.deepEqual(classificationProblems(withProxy, ['A', 'B', 'S', 'P']), []);
  assert.match(classificationProblems(m, ['A', 'B', 'S', 'P']).join('\n'), /not classified.*P/);
  assert.match(
    classificationProblems({ facets: ['P'], proxy: ['P'], standalone: [] }, ['P']).join('\n'),
    /named twice.*P/,
  );
});

test('the union drops only exact duplicates — every facet entry is still in it', () => {
  const union = new Set(JSON.parse(readFileSync(UNION_PATH, 'utf8')).map(canonical));
  for (const name of manifest.facets) {
    for (const entry of readFacetAbi(name)) {
      assert.ok(union.has(canonical(entry)), `${name}: ${entry.type} ${entry.name ?? ''} is missing from the union`);
    }
  }
});

test("the union carries every error and event the proxy declares (#2399)", () => {
  // The Diamond's own fallback reverts FunctionDoesNotExist() for an unrouted
  // selector — the revert a stale ABI produces. If the proxy drops out of the
  // manifest, or the union stops taking its errors, this is what fails.
  assert.deepEqual(manifest.proxy, ['VaipakamDiamond']);
  const union = new Set(JSON.parse(readFileSync(UNION_PATH, 'utf8')).map(canonical));
  const declared = proxyEntries(readFacetAbi('VaipakamDiamond'));
  assert.ok(
    declared.some((e) => e.type === 'error' && e.name === 'FunctionDoesNotExist'),
    'VaipakamDiamond.json no longer declares FunctionDoesNotExist — re-export it',
  );
  for (const entry of declared) {
    assert.ok(union.has(canonical(entry)), `VaipakamDiamond: ${entry.type} ${entry.name} is missing from the union`);
  }
});

test("the union takes no proxy constructor, fallback or receive", () => {
  const union = JSON.parse(readFileSync(UNION_PATH, 'utf8'));
  for (const type of ['constructor', 'fallback', 'receive']) {
    assert.equal(union.filter((e) => e.type === type).length, 0, `the union carries a ${type}`);
  }
  // And the filter itself: of a proxy ABI, only errors and events survive.
  const abi = [
    { type: 'constructor', inputs: [] },
    { type: 'fallback' },
    { type: 'receive' },
    { type: 'error', name: 'E', inputs: [] },
    { type: 'event', name: 'V', inputs: [], anonymous: false },
  ];
  assert.deepEqual(
    buildDiamondAbi([], () => abi, ['P']).map((e) => e.type),
    ['error', 'event'],
  );
});

test('the union holds nothing that no facet or proxy declaration carries', () => {
  const sources = new Set([
    ...manifest.facets.flatMap((n) => readFacetAbi(n).map(canonical)),
    ...(manifest.proxy ?? []).flatMap((n) => proxyEntries(readFacetAbi(n)).map(canonical)),
  ]);
  for (const entry of JSON.parse(readFileSync(UNION_PATH, 'utf8'))) {
    assert.ok(sources.has(canonical(entry)), `${entry.type} ${entry.name ?? ''} is not from any facet or the proxy`);
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
