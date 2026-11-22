// Tests for scripts/build-error-catalogue.mjs and the committed catalogue (#3916).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import { readManifest } from './build-diamond-abi.mjs';
import {
  CATALOGUE_PATH,
  RAISERS_PATH,
  buildCatalogue,
  errorSignature,
  platformErrors,
  readMeanings,
  renderCatalogue,
} from './build-error-catalogue.mjs';

const sel = (sig) => toFunctionSelector(sig).toLowerCase();
const errs = (...sigs) =>
  new Map(sigs.map((s) => [sel(s), { signature: s, name: s.slice(0, s.indexOf('(')), inputs: [] }]));
const meanings = (entries, extra = {}) => ({ maxErrorsWithoutEntry: 0, shownByName: [], entries, ...extra });
const msg = (message, actor = 'user') => ({ actor, message });

test('the committed catalogue is current with the interfaces, the raisers and the meanings', () => {
  const { errors, problems } = platformErrors(readManifest());
  const raisers = JSON.parse(readFileSync(RAISERS_PATH, 'utf8'));
  const built = buildCatalogue({ errors, meanings: readMeanings(), raisers });
  assert.deepEqual([...problems, ...built.problems], []);
  assert.equal(readFileSync(CATALOGUE_PATH, 'utf8'), renderCatalogue(built.rows), 'run node packages/contracts/scripts/build-error-catalogue.mjs');
});

test('every error of every shipped interface has a row', () => {
  const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')).errors;
  const manifest = readManifest();
  for (const name of [...manifest.facets, ...manifest.proxy, ...manifest.standalone]) {
    const abi = JSON.parse(readFileSync(new URL(`../src/abis/${name}.json`, import.meta.url), 'utf8'));
    for (const e of abi) if (e.type === 'error') assert.ok(catalogue[sel(errorSignature(e))], `${name}: ${errorSignature(e)}`);
  }
});

test('a tuple input hashes from its expanded form', () => {
  const e = { name: 'E', inputs: [{ type: 'tuple', components: [{ type: 'uint256' }, { type: 'tuple[]', components: [{ type: 'address' }] }] }] };
  assert.equal(errorSignature(e), 'E((uint256,(address)[]))');
});

test('a signature key wins over a name key, and a name key covers every signature', () => {
  const errors = errs('E()', 'E(uint256)', 'F()');
  const { rows, problems } = buildCatalogue({ errors, meanings: meanings({ E: msg('by name'), 'E(uint256)': msg('by sig'), F: msg('f') }), raisers: {} });
  assert.deepEqual(problems, []);
  assert.equal(rows.get(sel('E()')).message, 'by name');
  assert.equal(rows.get(sel('E(uint256)')).message, 'by sig');
});

test('a meaning that names no shipped error is refused', () => {
  const { problems } = buildCatalogue({ errors: errs('E()'), meanings: meanings({ E: msg('x'), Gone: msg('y') }), raisers: {} });
  assert.match(problems.join('\n'), /meaning Gone: no error the platform ships/);
});

test('a malformed meaning is refused', () => {
  const { problems } = buildCatalogue({ errors: errs('E()'), meanings: meanings({ E: { actor: 'admin', message: '', extra: 1 } }), raisers: {} });
  const text = problems.join('\n');
  assert.match(text, /actor must be one of/);
  assert.match(text, /message must be a non-empty string/);
  assert.match(text, /unknown field/);
});

test('the count without a meaning may not rise, and must be lowered when it falls', () => {
  const errors = errs('E()', 'F()');
  const up = buildCatalogue({ errors, meanings: meanings({ E: msg('x') }, { maxErrorsWithoutEntry: 0 }), raisers: {} });
  assert.match(up.problems.join('\n'), /1 platform errors have no meaning, above the 0 allowed/);
  const down = buildCatalogue({ errors, meanings: meanings({ E: msg('x'), F: msg('y') }, { maxErrorsWithoutEntry: 1 }), raisers: {} });
  assert.match(down.problems.join('\n'), /lower maxErrorsWithoutEntry to 0/);
});

test('shownByName may not name an error that has a meaning, or none at all', () => {
  const { problems } = buildCatalogue({ errors: errs('E()'), meanings: meanings({ E: msg('x') }, { shownByName: ['E', 'Nope'] }), raisers: {} });
  const text = problems.join('\n');
  assert.match(text, /shownByName E: it has a meaning now/);
  assert.match(text, /shownByName Nope: no error/);
});

test('raisers must name catalogued errors, and a reached declaration must hash to its key', () => {
  const errors = errs('E()');
  const bad = buildCatalogue({ errors, meanings: meanings({ E: msg('x') }), raisers: { raisers: { [sel('Z()')]: ['A.f(0x01)'], '0x': ['A.g(0x02)'] } } });
  assert.match(bad.problems.join('\n'), /lists 0x[0-9a-f]{8}, which no shipped interface declares/);
  const wrong = buildCatalogue({ errors, meanings: meanings({ E: msg('x') }), raisers: { declarations: { [sel('Y()')]: { signature: 'X()', inputs: [] } }, raisers: {} } });
  assert.match(wrong.problems.join('\n'), /declares X\(\) under/);
  const reached = buildCatalogue({
    errors,
    meanings: meanings({ E: msg('x'), R: msg('r', 'operator') }),
    raisers: { declarations: { [sel('R()')]: { signature: 'R()', inputs: [] } }, raisers: { [sel('R()')]: ['A.f(0x01)'] } },
  });
  assert.deepEqual(reached.problems, []);
  assert.equal(reached.rows.get(sel('R()')).source, 'reached');
});

test('a reached declaration that collides with a shipped error is refused', () => {
  // burn(uint256) and collate_propagate_storage(bytes16) share 0x42966c68.
  const errors = errs('burn(uint256)');
  const { problems } = buildCatalogue({
    errors,
    meanings: meanings({ burn: msg('x') }),
    raisers: { declarations: { [sel('collate_propagate_storage(bytes16)')]: { signature: 'collate_propagate_storage(bytes16)', inputs: [] } }, raisers: {} },
  });
  assert.match(problems.join('\n'), /selector collision 0x42966c68: a shipped interface declares burn\(uint256\) and a reached contract raises collate_propagate_storage\(bytes16\)/);
});

test('Error(string) and Panic(uint256) are always catalogued; Panic is internal', () => {
  const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')).errors;
  assert.equal(catalogue[sel('Error(string)')].source, 'builtin');
  assert.equal(catalogue[sel('Panic(uint256)')].internal, true);
});
