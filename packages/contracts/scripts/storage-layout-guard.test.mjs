// Tests for contracts/script/storage-layout-guard.mjs (#1274 / #2092).
//
// The guard lives beside predeploy-check.sh because that is where it runs, and
// it has no dependencies because nothing there installs this workspace. Its
// tests live here because this package's `node --test` is what CI runs for the
// repository's node scripts, and here viem is available to check the guard's
// own Keccak-256 against.
//
// The layouts below are hand-built in the shape solc's `storageLayout` output
// takes, so each case states exactly which compiler fact changed. The source
// checks read solc's AST, so their cases use a real one: fixtures/
// storage-layout-guard/ast.json, generated from the .sol files beside it by
// regen.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 as viemKeccak, toHex, encodeAbiParameters } from 'viem';
import {
  applyExemption,
  applyRenames,
  appendOnlyVerdict,
  BUILD_CACHE_DIR,
  BUILD_OUT_DIR,
  buildCommand,
  contractArtifact,
  erc7201,
  GOLDEN_FILE,
  keccak256,
  ledgerFromLayout,
  loadBuild,
  parseArgs,
  pointerProblems,
  positionOf,
  readAcks,
  readRenames,
  readRoots,
  ROOTS_FILE,
  sha256,
  storagePointers,
  typeIndex,
  uupsContracts,
} from '../../../contracts/script/storage-layout-guard.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'storage-layout-guard');
const AST = JSON.parse(readFileSync(join(FIXTURES, 'ast.json'), 'utf8')).units;
const FIXTURE_SOURCE = readFileSync(join(FIXTURES, 'Fixture.sol'));

// ─── Layout builders ─────────────────────────────────────────────────────

const BASE_TYPES = {
  t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
  t_uint128: { encoding: 'inplace', label: 'uint128', numberOfBytes: '16' },
  t_uint16: { encoding: 'inplace', label: 'uint16', numberOfBytes: '2' },
  t_address: { encoding: 'inplace', label: 'address', numberOfBytes: '20' },
  t_bool: { encoding: 'inplace', label: 'bool', numberOfBytes: '1' },
  't_enum(Status)1': { encoding: 'inplace', label: 'enum Lib.Status', numberOfBytes: '1' },
  't_mapping(t_address,t_uint256)': { encoding: 'mapping', key: 't_address', value: 't_uint256', label: 'mapping(address => uint256)', numberOfBytes: '32' },
};

/** A member list → solc members, laid out the way solc packs them. */
function pack(fields, types) {
  let slot = 0;
  let offset = 0;
  const members = [];
  for (const [label, type] of fields) {
    const size = Number(types[type].numberOfBytes);
    if (offset + size > 32 || size >= 32 || types[type].members || types[type].encoding !== 'inplace' || types[type].base) {
      if (offset) slot++;
      offset = 0;
    }
    members.push({ label, slot: String(slot), offset, type });
    if (size >= 32 || types[type].members || types[type].encoding !== 'inplace' || types[type].base) {
      slot += Math.ceil(size / 32);
      offset = 0;
    } else {
      offset += size;
    }
  }
  return { members, slots: slot + (offset ? 1 : 0) };
}

function struct(id, label, fields, types) {
  const { members, slots } = pack(fields, types);
  types[id] = { encoding: 'inplace', label, members, numberOfBytes: String(slots * 32) };
  return id;
}

/** A namespace probe: one struct variable `probe` at slot 0. */
function probeLayout(fields, extraTypes = {}) {
  const types = { ...BASE_TYPES, ...extraTypes };
  struct('t_struct(Storage)1', 'struct Lib.Storage', fields, types);
  return { storage: [{ label: 'probe', slot: '0', offset: 0, type: 't_struct(Storage)1' }], types };
}

const ledger = (layout, opts = { probe: true }) => {
  const l = ledgerFromLayout('ns', layout, opts);
  return { layout: [...l.layout], enums: [...l.enums], valueTypes: [...l.valueTypes] };
};
const verdict = (before, after, opts = { probe: true }, extra = {}) => appendOnlyVerdict(ledger(before, opts), ledger(after, opts), extra);

const BASE_FIELDS = [
  ['owner', 't_address'],
  ['paused', 't_bool'],
  ['total', 't_uint256'],
  ['balances', 't_mapping(t_address,t_uint256)'],
];

// ─── The append-only rule ────────────────────────────────────────────────

test('appending a field passes', () => {
  const v = verdict(probeLayout(BASE_FIELDS), probeLayout([...BASE_FIELDS, ['added', 't_uint256']]));
  assert.deepEqual(v.breaks, []);
});

test('a struct that reaches itself through a mapping is recorded once, not expanded forever', () => {
  const types = { ...BASE_TYPES };
  const nodeMap = 't_mapping(t_uint256,t_struct(Node)2_storage)';
  types[nodeMap] = { encoding: 'mapping', key: 't_uint256', value: 't_struct(Node)2_storage', label: 'mapping(uint256 => struct Lib.Node)', numberOfBytes: '32' };
  struct('t_struct(Node)2_storage', 'struct Lib.Node', [['value', 't_uint256'], ['children', nodeMap]], types);
  const selfMap = 't_mapping(t_uint256,t_struct(Storage)1)';
  types[selfMap] = { encoding: 'mapping', key: 't_uint256', value: 't_struct(Storage)1', label: 'mapping(uint256 => struct Lib.Storage)', numberOfBytes: '32' };
  const l = ledger(probeLayout([['root', 't_struct(Node)2_storage'], ['nested', selfMap]], types));
  assert.deepEqual(l.layout.sort(), [
    'C|ns|0|0|root',
    'L|ns|0|0|uint256|root.value',
    'M|ns|1|0|uint256|root.children',
    'M|ns|2|0|uint256|nested',
    'R|ns@1[uint256]|0|0|struct Lib.Node|root.children[]',
    'R|ns@2[uint256]|0|0|struct Lib.Storage|nested[]',
  ].sort());
  // The recursive struct's own fields are still checked, once.
  const types2 = { ...types };
  struct('t_struct(Node)2_storage', 'struct Lib.Node', [['children', nodeMap], ['value', 't_uint256']], types2);
  const v = verdict(probeLayout([['root', 't_struct(Node)2_storage'], ['nested', selfMap]], types), probeLayout([['root', 't_struct(Node)2_storage'], ['nested', selfMap]], types2));
  assert.ok(v.breaks.includes('L|ns|0|0|uint256|root.value'));
});

test('inserting a field in the middle shifts every later field', () => {
  const after = [BASE_FIELDS[0], BASE_FIELDS[1], ['inserted', 't_uint256'], BASE_FIELDS[2], BASE_FIELDS[3]];
  const v = verdict(probeLayout(BASE_FIELDS), probeLayout(after));
  assert.ok(v.breaks.includes('L|ns|1|0|uint256|total'), 'total moved off slot 1');
  assert.ok(v.breaks.includes('M|ns|2|0|address|balances'), 'balances moved off slot 2');
});

test('inserting a same-typed field into a run of them is caught by the name', () => {
  // Position and type alone see [uint256, uint256] become [uint256, uint256,
  // uint256] — indistinguishable from an append. `b` now reads `new`'s slot.
  const before = [['a', 't_uint256'], ['b', 't_uint256']];
  const v = verdict(probeLayout(before), probeLayout([before[0], ['inserted', 't_uint256'], before[1]]));
  assert.deepEqual(v.breaks, ['L|ns|1|0|uint256|b']);
});

test('removing a field shifts the fields after it', () => {
  const v = verdict(probeLayout(BASE_FIELDS), probeLayout([BASE_FIELDS[0], BASE_FIELDS[1], BASE_FIELDS[3]]));
  assert.ok(v.breaks.includes('L|ns|1|0|uint256|total'));
  assert.ok(v.breaks.includes('M|ns|2|0|address|balances'));
});

test('removing a packed field that shifts nothing is still one break', () => {
  // The 2026-08-16 removal: an address packed behind a uint16 — nothing after
  // it moved, but the slot it occupied is no longer described.
  const before = [['flag', 't_uint16'], ['messenger', 't_address'], ['total', 't_uint256']];
  const v = verdict(probeLayout(before), probeLayout([before[0], before[2]]));
  assert.deepEqual(v.breaks, ['L|ns|0|2|address|messenger']);
});

test('retyping a field breaks even when its slot is unchanged', () => {
  const after = BASE_FIELDS.map(([l, t]) => (l === 'total' ? [l, 't_uint128'] : [l, t]));
  const v = verdict(probeLayout(BASE_FIELDS), probeLayout(after));
  assert.ok(v.breaks.includes('L|ns|1|0|uint256|total'));
});

test('reordering two fields breaks', () => {
  const after = [BASE_FIELDS[0], BASE_FIELDS[1], BASE_FIELDS[3], BASE_FIELDS[2]];
  assert.ok(verdict(probeLayout(BASE_FIELDS), probeLayout(after)).breaks.length > 0);
});

// ─── Renames ─────────────────────────────────────────────────────────────

const RENAME_TOTAL = { region: 'ns', slot: '1', offset: 0, from: 'total', to: 'supply', reason: 'same value' };

test('an undeclared rename is a break', () => {
  const after = BASE_FIELDS.map(([l, t]) => (l === 'total' ? ['supply', t] : [l, t]));
  assert.deepEqual(verdict(probeLayout(BASE_FIELDS), probeLayout(after)).breaks, ['L|ns|1|0|uint256|total']);
});

test('a declared rename passes', () => {
  const after = BASE_FIELDS.map(([l, t]) => (l === 'total' ? ['supply', t] : [l, t]));
  assert.deepEqual(verdict(probeLayout(BASE_FIELDS), probeLayout(after), { probe: true }, { renames: [RENAME_TOTAL] }).breaks, []);
});

test('a declared rename does not excuse a move', () => {
  // Renamed AND moved: the rename rewrites the base line, and the moved field
  // is still missing from where the base had it.
  const after = [BASE_FIELDS[0], BASE_FIELDS[1], BASE_FIELDS[3], ['supply', 't_uint256']];
  assert.ok(verdict(probeLayout(BASE_FIELDS), probeLayout(after), { probe: true }, { renames: [RENAME_TOTAL] }).breaks.includes('L|ns|1|0|uint256|supply'));
});

test('a rename rewrites the nested lines of the renamed field', () => {
  const lines = ['M|ns|0|0|uint256|byId', 'L|ns@0[uint256]|0|0|uint256|byId[].a', 'L|ns|1|0|uint256|byIdCount'];
  const r = { region: 'ns', slot: '0', offset: 0, from: 'byId', to: 'loans', reason: 'x' };
  assert.deepEqual(applyRenames(lines, [r]), ['M|ns|0|0|uint256|loans', 'L|ns@0[uint256]|0|0|uint256|loans[].a', 'L|ns|1|0|uint256|byIdCount']);
});

test('an inline struct field is renamed through its container line', () => {
  const types = { ...BASE_TYPES };
  struct('t_struct(Inner)2', 'struct Lib.Inner', [['a', 't_uint256'], ['b', 't_uint256']], types);
  const before = ledger(probeLayout([['cfg', 't_struct(Inner)2'], ['total', 't_uint256']], types));
  const after = ledger(probeLayout([['config', 't_struct(Inner)2'], ['total', 't_uint256']], types));
  assert.ok(before.layout.includes('C|ns|0|0|cfg'));
  assert.equal(appendOnlyVerdict(before, after).breaks.length, 3, 'undeclared: the container and both members');
  const r = { region: 'ns', slot: '0', offset: 0, from: 'cfg', to: 'config', reason: 'same struct, new name' };
  assert.deepEqual(appendOnlyVerdict(before, after, { renames: [r] }).breaks, []);
});

test('a fixed array of structs is renamed through its container line', () => {
  const types = { ...BASE_TYPES };
  struct('t_struct(Inner)2', 'struct Lib.Inner', [['a', 't_uint256']], types);
  types['t_array(t_struct(Inner)2)3_storage'] = { encoding: 'inplace', base: 't_struct(Inner)2', label: 'struct Lib.Inner[3]', numberOfBytes: '96' };
  const before = ledger(probeLayout([['legs', 't_array(t_struct(Inner)2)3_storage']], types));
  const after = ledger(probeLayout([['parts', 't_array(t_struct(Inner)2)3_storage']], types));
  const r = { region: 'ns', slot: '0', offset: 0, from: 'legs', to: 'parts', reason: 'same array, new name' };
  assert.ok(appendOnlyVerdict(before, after).breaks.length > 0);
  assert.deepEqual(appendOnlyVerdict(before, after, { renames: [r] }).breaks, []);
});

test('a rename applies only to a ledger that has the field at its anchor', () => {
  // Long after `total` became `supply`, a NEW field named `total` appears at
  // slot 9. The old declaration must not rewrite it.
  const later = ['L|ns|1|0|uint256|supply', 'L|ns|9|0|uint256|total'];
  assert.deepEqual(applyRenames(later, [RENAME_TOTAL]), later);
});

test('an enum member rename is declared by index', () => {
  const lines = ['E|enum Lib.Status|0|Active', 'E|enum Lib.Status|1|Done'];
  const r = { enum: 'enum Lib.Status', index: 1, from: 'Done', to: 'Repaid', reason: 'x' };
  assert.deepEqual(applyRenames(lines, [r]), ['E|enum Lib.Status|0|Active', 'E|enum Lib.Status|1|Repaid']);
});

test('a malformed rename is an error', () => {
  assert.equal(readRenames(JSON.stringify({ renames: [RENAME_TOTAL] })).length, 1);
  assert.throws(() => readRenames(JSON.stringify({ renames: [{ ...RENAME_TOTAL, reason: '' }] })), /reason/);
  assert.throws(() => readRenames(JSON.stringify({ renames: [{ ...RENAME_TOTAL, to: 'total' }] })), /distinct/);
  assert.throws(() => readRenames(JSON.stringify({ renames: [{ from: 'a', to: 'b', reason: 'x' }] })), /anchors/);
  assert.throws(() => readRenames(JSON.stringify({ renames: [{ enum: 'enum X', from: 'a', to: 'b', reason: 'x' }] })), /index/);
});

// ─── Nested regions ──────────────────────────────────────────────────────

function withInner(innerFields, outerFields) {
  const types = { ...BASE_TYPES };
  struct('t_struct(Inner)2', 'struct Lib.Inner', innerFields, types);
  return probeLayout(outerFields, types);
}

test('growing an inline struct in the middle shifts what follows it', () => {
  const outer = [['inner', 't_struct(Inner)2'], ['total', 't_uint256']];
  const v = verdict(withInner([['a', 't_uint256']], outer), withInner([['a', 't_uint256'], ['b', 't_uint256']], outer));
  assert.ok(v.breaks.includes('L|ns|1|0|uint256|total'), 'total moved from slot 1 to slot 2');
});

test('growing an inline struct that is the last member passes', () => {
  const outer = [['total', 't_uint256'], ['inner', 't_struct(Inner)2']];
  const v = verdict(withInner([['a', 't_uint256']], outer), withInner([['a', 't_uint256'], ['b', 't_uint256']], outer));
  assert.deepEqual(v.breaks, []);
});

function mappingOf(innerFields) {
  const types = { ...BASE_TYPES };
  struct('t_struct(Inner)2', 'struct Lib.Inner', innerFields, types);
  types['t_mapping(t_uint256,t_struct(Inner)2)'] = { encoding: 'mapping', key: 't_uint256', value: 't_struct(Inner)2', label: 'mapping(uint256 => struct Lib.Inner)', numberOfBytes: '32' };
  return probeLayout([['byId', 't_mapping(t_uint256,t_struct(Inner)2)'], ['total', 't_uint256']], types);
}

test('a mapping value struct may grow: each value has its own hashed region', () => {
  const v = verdict(mappingOf([['a', 't_uint256']]), mappingOf([['a', 't_uint256'], ['b', 't_uint256']]));
  assert.deepEqual(v.breaks, []);
  assert.ok(ledger(mappingOf([['a', 't_uint256']])).layout.includes('L|ns@0[uint256]|0|0|uint256|byId[].a'));
});

test('a mapping value struct may not reorder', () => {
  const v = verdict(mappingOf([['a', 't_uint256'], ['b', 't_address']]), mappingOf([['b', 't_address'], ['a', 't_uint256']]));
  assert.ok(v.breaks.length > 0);
});

function arrayOf(innerFields) {
  const types = { ...BASE_TYPES };
  struct('t_struct(Inner)2', 'struct Lib.Inner', innerFields, types);
  types['t_array(t_struct(Inner)2)dyn_storage'] = { encoding: 'dynamic_array', base: 't_struct(Inner)2', label: 'struct Lib.Inner[]', numberOfBytes: '32' };
  return probeLayout([['items', 't_array(t_struct(Inner)2)dyn_storage']], types);
}

test('a dynamic array element struct may not grow: the stride moves every element', () => {
  const v = verdict(arrayOf([['a', 't_uint256']]), arrayOf([['a', 't_uint256'], ['b', 't_uint256']]));
  assert.deepEqual(v.breaks, ['W|ns@0[]|32']);
});

// ─── __gap ───────────────────────────────────────────────────────────────

function gapped(fields, gapLen) {
  const types = { ...BASE_TYPES };
  const gapType = `t_array(t_uint256)${gapLen}_storage`;
  types[gapType] = { encoding: 'inplace', base: 't_uint256', label: `uint256[${gapLen}]`, numberOfBytes: String(32 * gapLen) };
  // A UUPS contract's own variables, not a probe.
  const storage = [];
  let slot = 0;
  for (const [label, type] of [...fields, ['__gap', gapType], ['after', 't_uint256']]) {
    storage.push({ label, slot: String(slot), offset: 0, type });
    slot += Math.ceil(Number(types[type].numberOfBytes) / 32);
  }
  return { storage, types };
}

test('a field may take space a __gap gives up', () => {
  const v = verdict(gapped([['a', 't_uint256']], 50), gapped([['a', 't_uint256'], ['b', 't_uint256']], 49), {});
  assert.deepEqual(v.breaks, []);
});

test('shrinking a __gap by the wrong amount moves the field after it', () => {
  const v = verdict(gapped([['a', 't_uint256']], 50), gapped([['a', 't_uint256'], ['b', 't_uint256']], 50), {});
  assert.deepEqual(v.breaks, ['L|ns|51|0|uint256|after']);
});

// ─── Enums, probes ───────────────────────────────────────────────────────

test('enum members and value types come from the compiler\'s declarations', () => {
  const types = typeIndex([AST['Fixture.sol']]);
  assert.deepEqual(types.enums.get('LibFixture.Status'), ['Active', 'Repaid']);
  assert.equal(types.valueTypes.get('LibFixture.Amount'), 'uint128');
  const ledgerOf = (members) => members.map((m, i) => `E|enum Lib.Status|${i}|${m}`);
  assert.deepEqual(appendOnlyVerdict({ layout: ledgerOf(['Active', 'Repaid']) }, { layout: ledgerOf(['Active', 'Repaid', 'Settled']) }).breaks, []);
  assert.deepEqual(appendOnlyVerdict({ layout: ledgerOf(['Active', 'Repaid']) }, { layout: ledgerOf(['Repaid', 'Active']) }).breaks.length, 2);
  assert.ok(ledger(probeLayout([['status', 't_enum(Status)1']])).enums.includes('enum Lib.Status'));
});

test('an enum or value type declared twice is ambiguous, not guessed', () => {
  const types = typeIndex([AST['Fixture.sol'], AST['Fixture.sol']]);
  assert.equal(types.enums.get('LibFixture.Status'), null);
  assert.equal(types.valueTypes.get('LibFixture.Amount'), null);
});

test('a value type records what it wraps, so a retype of the same width breaks', () => {
  const udvt = { 't_userDefinedValueType(Amount)9': { encoding: 'inplace', label: 'Lib.Amount', numberOfBytes: '16' } };
  const l = ledger(probeLayout([['amount', 't_userDefinedValueType(Amount)9']], udvt));
  assert.deepEqual(l.valueTypes, ['Lib.Amount']);
  // The layout line is the same whatever Amount wraps; the U line is not.
  const v = appendOnlyVerdict({ layout: [...l.layout, 'U|Lib.Amount|uint128'] }, { layout: [...l.layout, 'U|Lib.Amount|int128'] });
  assert.deepEqual(v.breaks, ['U|Lib.Amount|uint128']);
});

test('a probe must declare exactly one struct at slot 0', () => {
  const two = probeLayout(BASE_FIELDS);
  two.storage.push({ label: 'extra', slot: '1', offset: 0, type: 't_uint256' });
  assert.throws(() => ledgerFromLayout('ns', two, { probe: true }), /exactly one struct/);
});

// ─── Positions and hashing ───────────────────────────────────────────────

test('keccak256 matches viem across the block-size boundary', () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 31) % 256);
  for (const n of [0, 1, 55, 135, 136, 137, 271, 272, 300]) {
    assert.equal(keccak256(bytes.slice(0, n)), viemKeccak(bytes.slice(0, n)), `length ${n}`);
  }
});

test('erc7201 matches the EIP example and a viem derivation', () => {
  // EIP-7201's own example namespace.
  assert.equal(erc7201('example.main'), '0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500');
  const id = 'vaipakam.storage.Guardian';
  const inner = BigInt(viemKeccak(toHex(id))) - 1n;
  const expected = toHex(BigInt(viemKeccak(encodeAbiParameters([{ type: 'uint256' }], [inner]))) & ~0xffn, { size: 32 });
  assert.equal(erc7201(id), expected);
});

test('positionOf evaluates the forms the tree uses, from the AST', () => {
  const unit = AST['Fixture.sol'];
  const ozFormula = (id) => {
    const inner = BigInt(viemKeccak(toHex(id))) - 1n;
    return toHex(BigInt(viemKeccak(encodeAbiParameters([{ type: 'uint256' }], [inner]))) & ~0xffn, { size: 32 });
  };
  assert.equal(positionOf('A_POS', unit, FIXTURE_SOURCE), ozFormula('fixture.a'));
  assert.equal(positionOf('B_POS', unit, FIXTURE_SOURCE), viemKeccak(toHex('fixture.b')));
  assert.equal(positionOf('C_POS', unit, FIXTURE_SOURCE), ozFormula('fixture.c'));
  assert.equal(positionOf('D_POS', unit, FIXTURE_SOURCE), ozFormula('fixture.c'), 'a constant defined as another constant');
  assert.throws(() => positionOf('NOPE', unit, FIXTURE_SOURCE), /exactly one constant/);
});

test('a literal position that disagrees with its own ERC-7201 comment is refused', () => {
  assert.throws(() => positionOf('WRONG_POS', AST['Fixture.sol'], FIXTURE_SOURCE), /comment derives/);
});

test('a changed namespace position is a break', () => {
  const v = appendOnlyVerdict({ layout: ['P|ns|0x01'] }, { layout: ['P|ns|0x02'] });
  assert.deepEqual(v.breaks, ['P|ns|0x01']);
});

// ─── Completeness: storage pointers ──────────────────────────────────────

const pointersOf = (name) => {
  // The fixture's unit with every function but `name` taken out.
  const ast = AST['Fixture.sol'];
  return storagePointers({ ...ast, nodes: ast.nodes.map((c) => (c.nodes ? { ...c, nodes: c.nodes.filter((n) => n.nodeType !== 'FunctionDefinition' || n.name === name) } : c)) });
};

test('storagePointers resolves a constant, a local, and a constant defined as another', () => {
  assert.deepEqual(pointersOf('direct').map(({ struct, constant }) => ({ struct, constant })), [{ struct: 'LibFixture.S', constant: 'A_POS' }]);
  assert.deepEqual(pointersOf('viaLocal').map(({ struct, constant }) => ({ struct, constant })), [{ struct: 'LibFixture.S', constant: 'B_POS' }]);
  assert.deepEqual(pointersOf('viaConstantAlias').map(({ struct, constant }) => ({ struct, constant })), [{ struct: 'LibFixture.S', constant: 'D_POS' }]);
  assert.deepEqual(pointersOf('otherView').map(({ struct, constant }) => ({ struct, constant })), [{ struct: 'LibFixture.Other', constant: 'A_POS' }]);
});

test('storagePointers ignores a read of a slot', () => {
  assert.deepEqual(pointersOf('readOnly'), []);
});

test('storagePointers reports a position it cannot name', () => {
  assert.match(pointersOf('computed')[0].error, /not initialised from a named position constant/);
});

test('storagePointers refuses a position local used anywhere besides its one read, whatever the form of write', () => {
  for (const name of ['reassigned', 'deleted', 'tupleAssigned', 'yulAssigned']) {
    const [p] = pointersOf(name);
    assert.equal(p.constant, undefined, name);
    assert.match(p.error, /used again besides this read/, name);
  }
});

test('storagePointers marks a slot taken from a parameter, value or storage reference', () => {
  for (const name of ['fromParameter', 'fromStorageParameter']) {
    const [p] = pointersOf(name);
    assert.equal(p.parameter, true, name);
    assert.match(p.error, /takes its slot from the parameter/, name);
  }
  assert.equal(pointersOf('direct')[0].parameter, undefined);
});

test('an exemption passes only the pointers that take their slot from a parameter', () => {
  const generic = { struct: 'StorageSlot.AddressSlot', parameter: true, error: 'x', src: '1' };
  const added = { struct: 'StorageSlot.Ns', constant: 'NS_POS', src: '2' };
  assert.deepEqual(applyExemption([generic, added]), { exempted: [generic], kept: [added] });
  assert.deepEqual(applyExemption([added]).exempted, []);
});

test('storagePointers follows a parameterless function that returns a constant, and says it is virtual', () => {
  const [p] = storagePointers({ ...AST['Fixture.sol'], nodes: AST['Fixture.sol'].nodes.filter((n) => n.name !== 'LibFixture') });
  assert.equal(p.struct, 'VirtualPosition.V');
  assert.equal(p.constant, 'V_POS');
  assert.equal(p.via, '_vPosition');
});

const NS = { id: 'a', probe: 'ProbeA', positionFile: 'Fixture.sol', positionConstant: 'A_POS' };
const at = (p) => ({ ...p, file: 'Fixture.sol', at: 'Fixture.sol:1' });

test('every view of a rooted namespace must be the probed struct', () => {
  const pointers = [at({ struct: 'LibFixture.S', constant: 'A_POS' }), at({ struct: 'LibFixture.Other', constant: 'A_POS' })];
  const problems = pointerProblems({ namespaces: [NS], probeStructs: { a: 'LibFixture.S' }, pointers, functionFiles: new Map() });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /as LibFixture.Other, but its root probes LibFixture.S/);
});

test('a pointer no root names, and a root no pointer binds, are both refused', () => {
  const problems = pointerProblems({ namespaces: [NS], probeStructs: { a: 'LibFixture.S' }, pointers: [at({ struct: 'LibFixture.S', constant: 'B_POS' })], functionFiles: new Map() });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /no namespace root in roots.json names that position/.test(p)));
  assert.ok(problems.some((p) => /sets no storage pointer from A_POS/.test(p)));
});

test('a position from an overridden virtual function is refused', () => {
  const ns = { ...NS, positionConstant: 'V_POS' };
  const pointer = at({ struct: 'VirtualPosition.V', constant: 'V_POS', via: '_vPosition' });
  const once = pointerProblems({ namespaces: [ns], probeStructs: { a: 'VirtualPosition.V' }, pointers: [pointer], functionFiles: new Map([['_vPosition', ['Fixture.sol']]]) });
  assert.deepEqual(once, []);
  const files = new Map([['_vPosition', ['Fixture.sol', 'Overridden.sol']]]);
  const problems = pointerProblems({ namespaces: [ns], probeStructs: { a: 'VirtualPosition.V' }, pointers: [pointer], functionFiles: files });
  assert.ok(problems.some((p) => /virtual and declared 2 times/.test(p)));
  assert.ok(AST['Overridden.sol'].nodes.some((n) => n.name === 'OverridesPosition'), 'the fixture really overrides it');
});

// ─── Completeness: artifacts and UUPS ────────────────────────────────────

test('uupsContracts reads proxiableUUID() from the compiler, however the contract reaches it', () => {
  const c = (name, target, code, uups) => ({ name, target, art: { deployedBytecode: { object: code }, methodIdentifiers: uups ? { 'proxiableUUID()': '52d1902d' } : {} } });
  const contracts = [
    c('Qualified', 'src/A.sol', '0x6080', true), // e.g. `is OZ.UUPSUpgradeable`
    c('AbstractBase', 'src/A.sol', '0x', true),
    c('Plain', 'src/B.sol', '0x6080', false),
    c('TestDouble', 'test/C.sol', '0x6080', true),
  ];
  assert.deepEqual(uupsContracts(contracts), ['Qualified']);
});

/** A temporary contracts/ tree with one source and one forge-shaped artifact. */
function tree({ target = 'src/A.sol', compiledFrom = 'contract A {}', onDisk = compiledFrom, name = 'A' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'slg-'));
  const out = join(root, 'out');
  mkdirSync(join(root, dirname(target)), { recursive: true });
  if (onDisk !== null) writeFileSync(join(root, target), onDisk);
  mkdirSync(join(out, `${name}.sol`), { recursive: true });
  const art = {
    abi: [{ type: 'function', name: 'f' }],
    storageLayout: { storage: [], types: {} },
    metadata: { settings: { compilationTarget: { [target]: name } }, sources: { [target]: { keccak256: keccak256(Buffer.from(compiledFrom)) } } },
    ast: { nodeType: 'SourceUnit', absolutePath: target, nodes: [] },
  };
  writeFileSync(join(out, `${name}.sol`, `${name}.json`), JSON.stringify(art));
  return { root, out, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('an artifact compiled from the file on disk is used', () => {
  const t = tree();
  try {
    const build = loadBuild(t.out, { root: t.root });
    assert.deepEqual(build.problems, []);
    assert.ok(contractArtifact(build, 'A').storageLayout);
    assert.ok(build.scope.has('src/A.sol'));
  } finally {
    t.cleanup();
  }
});

test('a stale artifact of a file that still exists is refused', () => {
  const t = tree({ compiledFrom: 'contract A {}', onDisk: 'contract A { uint256 x; }' });
  try {
    const build = loadBuild(t.out, { root: t.root });
    assert.match(build.problems.join('\n'), /was not compiled from the current src\/A.sol/);
    assert.throws(() => contractArtifact(build, 'A'), /found 0/);
  } finally {
    t.cleanup();
  }
});

test('a leftover artifact of a deleted source is never read', () => {
  const t = tree({ onDisk: null });
  try {
    const build = loadBuild(t.out, { root: t.root });
    assert.deepEqual(build.problems, []);
    assert.throws(() => contractArtifact(build, 'A'), /found 0/);
  } finally {
    t.cleanup();
  }
});

test('a lone artifact compiled outside src/ is never a root', () => {
  const t = tree({ target: 'test/A.sol' });
  try {
    assert.throws(() => contractArtifact(loadBuild(t.out, { root: t.root }), 'A'), /compiled from src\/, found 0/);
  } finally {
    t.cleanup();
  }
});

test('an artifact with no metadata is a problem, not a skip', () => {
  const t = tree();
  try {
    const file = join(t.out, 'A.sol', 'A.json');
    const art = JSON.parse(readFileSync(file, 'utf8'));
    delete art.metadata;
    writeFileSync(file, JSON.stringify(art));
    assert.match(loadBuild(t.out, { root: t.root }).problems.join('\n'), /no metadata/);
  } finally {
    t.cleanup();
  }
});

// ─── Acknowledgements ────────────────────────────────────────────────────

test('an acknowledgement applies only to the base it names', () => {
  const base = { layout: ['L|ns|0|0|uint256|a', 'L|ns|1|0|uint256|b'] };
  const current = { layout: [] };
  const ack = { baseSha256: 'a'.repeat(64), lines: ['L|ns|0|0|uint256|a'], reason: 'test' };
  const live = appendOnlyVerdict(base, current, { baseSha256: 'a'.repeat(64), acks: [ack] });
  assert.deepEqual(live.breaks, ['L|ns|1|0|uint256|b']);
  assert.deepEqual(live.acknowledged, ['L|ns|0|0|uint256|a']);
  const inert = appendOnlyVerdict(base, current, { baseSha256: 'b'.repeat(64), acks: [ack] });
  assert.equal(inert.breaks.length, 2);
  assert.equal(inert.staleAcks, 1);
});

test('a live acknowledgement may list only lines the change removes', () => {
  const base = { layout: ['L|ns|0|0|uint256|a', 'L|ns|1|0|uint256|b'] };
  const ack = { baseSha256: 'a'.repeat(64), lines: ['L|ns|0|0|uint256|a', 'L|ns|1|0|uint256|b'], reason: 'test' };
  const v = appendOnlyVerdict(base, { layout: ['L|ns|1|0|uint256|b'] }, { baseSha256: 'a'.repeat(64), acks: [ack] });
  assert.deepEqual(v.breaks, []);
  assert.deepEqual(v.acknowledged, ['L|ns|0|0|uint256|a']);
  assert.deepEqual(v.overreach, ['L|ns|1|0|uint256|b']);
  assert.deepEqual(appendOnlyVerdict(base, { layout: [] }, { baseSha256: 'a'.repeat(64), acks: [ack] }).overreach, []);
  // An inert acknowledgement (another base) is reported as stale, not as overreach.
  assert.deepEqual(appendOnlyVerdict(base, { layout: base.layout }, { baseSha256: 'b'.repeat(64), acks: [ack] }).overreach, []);
});

test('a malformed acknowledgement is an error, not a silent ack', () => {
  const ok = { baseSha256: 'a'.repeat(64), lines: ['L|ns|0|0|uint256|a'], reason: 'x' };
  assert.equal(readAcks(JSON.stringify({ acks: [ok] })).length, 1);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, baseSha256: 'abc' }] })), /baseSha256/);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, lines: [] }] })), /lines/);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, reason: ' ' }] })), /reason/);
});

// ─── CLI ─────────────────────────────────────────────────────────────────

test('the guard builds its own artifacts, apart from the shared out/', () => {
  const { cmd, args, env } = buildCommand();
  assert.equal(cmd, 'forge');
  assert.equal(env.FOUNDRY_PROFILE, 'quick');
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(args[0], 'build');
  assert.ok(args.includes('--ast'));
  assert.equal(flag('--extra-output'), 'storageLayout');
  assert.equal(flag('--out'), BUILD_OUT_DIR);
  assert.equal(flag('--cache-path'), BUILD_CACHE_DIR);
  // Neither output is configured in foundry.toml: setting one there changes
  // CI's forge cache key for every forge job (#2600).
  const toml = readFileSync(join(dirname(GOLDEN_FILE), '..', 'foundry.toml'), 'utf8');
  assert.doesNotMatch(toml, /^\s*ast\s*=/m);
  assert.doesNotMatch(toml, /storageLayout/);
});

test('the command line is parsed strictly', () => {
  assert.deepEqual(parseArgs(['check']), { mode: 'check' });
  assert.deepEqual(parseArgs(['check', '--base', 'b.json', '--honour-acks', '--out', 'o']), { mode: 'check', base: 'b.json', honourAcks: true, out: 'o' });
  assert.throws(() => parseArgs(['check', '--base']), /needs a value/);
  assert.throws(() => parseArgs(['check', '--base', '--out', 'o']), /needs a value/);
  assert.throws(() => parseArgs(['check', '--bsae', 'b.json']), /unknown argument --bsae/);
  assert.throws(() => parseArgs(['check', '--out', 'a', '--out', 'b']), /twice/);
  assert.throws(() => parseArgs(['check', '--honour-acks']), /only to a --base/);
  assert.throws(() => parseArgs(['write', '--base', 'b.json']), /write takes no/);
  assert.throws(() => parseArgs(['verify']), /usage/);
  assert.throws(() => parseArgs([]), /usage/);
});

// ─── The committed files ─────────────────────────────────────────────────

test('the committed golden file names every root and one position per namespace', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'));
  const roots = readRoots(readFileSync(ROOTS_FILE, 'utf8'));
  const expectedRoots = [...roots.namespaces.map((n) => n.id), ...roots.uups.map((c) => `uups:${c}`)].sort();
  assert.deepEqual(golden.roots, expectedRoots);
  for (const ns of roots.namespaces) {
    assert.equal(golden.layout.filter((l) => l.startsWith(`P|${ns.id}|`)).length, 1, `${ns.id} position`);
  }
  for (const e of roots.pointerExemptions) assert.ok(e.reason.length > 40, `${e.file} exemption says why`);
  assert.equal(sha256('x').length, 64);
});
