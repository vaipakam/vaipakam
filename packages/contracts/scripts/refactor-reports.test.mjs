// Tests for contracts/script/refactor-reports.mjs and the event-category lint
// it wires in (#3914, RefactorRulesDesign section 9).
//
// The reports read solc's AST, so these cases read a real one:
// fixtures/refactor-reports/ast.json, generated from src/Fixture.sol beside it
// by regen.mjs. Every function in the fixture is one case a report must list,
// or one it must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  compare,
  keccak256Hex,
  ledgerProblems,
  runReports,
  abiType,
  errorAbiSig,
} from '../../../contracts/script/refactor-reports.mjs';

const require = createRequire(import.meta.url);
const { lintEvents } = require('../../../contracts/script/lint-event-categories.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'refactor-reports');
const UNITS = Object.values(JSON.parse(readFileSync(join(FIXTURE, 'ast.json'), 'utf8')).units);
const MANIFEST = { facets: ['AFacet', 'BFacet'], standalone: [] };
const CATALOGUE = { errors: { '0x5b9b0f1e': { signature: 'Bad()', name: 'Bad' } } };
const R = runReports(UNITS, MANIFEST, CATALOGUE, undefined);
const has = (report, prefix) => R[report].entries.some((e) => e.startsWith(prefix));

test('keccak256 matches known values (selector constants depend on it)', () => {
  assert.equal(keccak256Hex(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256Hex('transfer(address,uint256)').slice(0, 8), 'a9059cbb');
});

test('silent functions: a state-changing entry whose reachable code emits nothing is listed', () => {
  assert.ok(has('silent-functions', 'AFacet.silentWrite()'));
  assert.ok(has('silent-functions', 'AFacet.catchReverts()'), 'a revert is not an event');
});

test('silent functions: an emit through a library or any named self-call counts', () => {
  for (const f of ['emitsThroughLibrary()', 'viaSelectorMember()', 'viaKeccakConstant()', 'viaMemberConstant()', 'viaSignature()', 'viaParameterHelper()']) {
    assert.ok(!has('silent-functions', `AFacet.${f}`), `${f} reaches BFacet.loud or LibLoud.did`);
  }
  assert.ok(!has('silent-functions', 'AFacet.readsInView()'), 'a view is not an entry for this report');
});

test('silent functions: a self-call whose selector the entry takes from its caller is UNKNOWN, never resolved', () => {
  const e = R['silent-functions'].entries.find((x) => x.startsWith('AFacet.viaUnnamed(bytes4)'));
  assert.match(e, /unknown self-call/);
});

test('swallowed failures: a catch or failed low-level call that neither reverts nor emits is listed', () => {
  assert.ok(has('swallowed-failures', 'AFacet.catchSwallows() try#1 catch#1'));
  assert.ok(has('swallowed-failures', 'AFacet.flagNeverRead() lowlevel#1'));
  assert.ok(!has('swallowed-failures', 'AFacet.catchReverts()'));
  assert.ok(!has('swallowed-failures', 'AFacet.catchEmits()'));
  assert.ok(!has('swallowed-failures', 'AFacet.flagChecked()'));
  assert.ok(has('swallowed-failures', 'AFacet.compoundSwallows() lowlevel#1'), 'a failure side inside `||` is a failure test');
  assert.ok(!has('swallowed-failures', 'AFacet.compoundChecked()'), '`!(ok && x)` reverting is a handled failure');
});

test('ambiguous errors: two raise sites of one parameterless error in one entry are listed, one is not', () => {
  assert.ok(has('ambiguous-errors', 'ambiguous AFacet.twoSites(uint256) :: Bad() x2'));
  assert.ok(!has('ambiguous-errors', 'ambiguous AFacet.oneSite('));
});

test('ambiguous errors: text reverts and errors missing from the catalogue are listed', () => {
  assert.ok(has('ambiguous-errors', 'text AFacet.textRevert()'));
  assert.ok(has('ambiguous-errors', 'uncatalogued Failed()'));
  assert.ok(!has('ambiguous-errors', 'uncatalogued Bad()'), 'Bad() is in the catalogue');
});

test('write-only storage: a field written by an entry and read only by a view, or never, is listed', () => {
  assert.ok(R['write-only-storage'].entries.includes('AFacet.neverRead'));
  assert.ok(R['write-only-storage'].entries.includes('AFacet.readOnlyInView'));
  assert.ok(R['write-only-storage'].entries.includes('AFacet.publicOnly (public getter)'));
  assert.ok(!R['write-only-storage'].entries.includes('AFacet.readByEntry'), 'silentWrite reads it');
});

test('compare: a new entry is worse unless the ledger lists it; a gone entry is reported', () => {
  const c = compare(['a', 'b', 'c'], ['a', 'z'], { c: 'accepted for a reason long enough' });
  assert.deepEqual(c.worse, ['b']);
  assert.deepEqual(c.improved, ['z']);
  assert.deepEqual(c.staleListed, []);
  assert.deepEqual(compare(['a'], ['a'], { q: 'x'.repeat(20) }).staleListed, ['q']);
});

test('ledger: a short reason or an unknown report is refused', () => {
  assert.equal(ledgerProblems({ 'silent-functions': { x: 'a reason that is long enough' } }).length, 0);
  assert.equal(ledgerProblems({ 'silent-functions': { x: 'short' } }).length, 1);
  assert.equal(ledgerProblems({ 'no-such-report': {} }).length, 1);
});

test('event-category lint: reads the tags from the AST in the artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-events-'));
  try {
    const unit = UNITS.find((u) => u.absolutePath === 'src/Fixture.sol');
    const ev = (name) => ({ type: 'event', name, anonymous: false, inputs: [] });
    mkdirSync(join(dir, 'Fixture.sol'));
    writeFileSync(
      join(dir, 'Fixture.sol', 'AFacet.json'),
      JSON.stringify({
        abi: [ev('Skipped'), ev('Untagged'), ev('Unknown')],
        metadata: { settings: { compilationTarget: { 'src/Fixture.sol': 'AFacet' } } },
        ast: unit,
      }),
    );
    const { violations, categoriesBySignature } = lintEvents(dir);
    const kinds = Object.fromEntries(violations.map((v) => [v.event, v.kind]));
    assert.equal(kinds['Untagged()'], 'MISSING_TAG');
    assert.equal(kinds['Unknown()'], 'UNKNOWN_LEAF');
    assert.equal(kinds['Skipped()'], undefined);
    assert.equal(categoriesBySignature['Skipped()'], 'informational/admin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an error is compared with the catalogue by its ABI signature: enum uint8, contract address, struct tuple, value type underlying', () => {
  const byId = new Map([
    [1, { nodeType: 'EnumDefinition' }],
    [2, { nodeType: 'ContractDefinition' }],
    [3, { nodeType: 'StructDefinition', members: [{ typeName: { nodeType: 'ElementaryTypeName', typeDescriptions: { typeString: 'uint256' } } }, { typeName: { nodeType: 'UserDefinedTypeName', referencedDeclaration: 1 } }] }],
    [4, { nodeType: 'UserDefinedValueTypeDefinition', underlyingType: { nodeType: 'ElementaryTypeName', typeDescriptions: { typeString: 'uint64' } } }],
  ]);
  const u = (id) => ({ typeName: { nodeType: 'UserDefinedTypeName', referencedDeclaration: id } });
  const err = { name: 'E', parameters: { parameters: [
    { typeName: { nodeType: 'ElementaryTypeName', typeDescriptions: { typeString: 'address payable' } } },
    u(1), u(2), u(3), u(4),
    { typeName: { nodeType: 'ArrayTypeName', baseType: u(1).typeName, length: { value: '3' } } },
  ] } };
  assert.equal(errorAbiSig(err, byId), 'E(address,uint8,address,(uint256,uint8),uint64,uint8[3])');
  assert.equal(abiType(undefined, byId), '?');
});
