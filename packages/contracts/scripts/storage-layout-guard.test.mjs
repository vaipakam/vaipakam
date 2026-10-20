// Tests for contracts/script/storage-layout-guard.mjs (#1274 / #2092).
//
// The guard lives beside predeploy-check.sh because that is where it runs, and
// it has no dependencies because nothing there installs this workspace. Its
// tests live here because this package's `node --test` is what CI runs for the
// repository's node scripts, and here viem is available to check the guard's
// own Keccak-256 against.
//
// The layouts below are hand-built in the shape solc's `storageLayout` output
// takes, so each case states exactly which compiler fact changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 as viemKeccak, toHex, encodeAbiParameters } from 'viem';
import {
  applyRenames,
  appendOnlyVerdict,
  CONTRACTS_DIR,
  enumMembers,
  erc7201,
  GOLDEN_FILE,
  keccak256,
  ledgerFromLayout,
  positionOf,
  readAcks,
  readRenames,
  ROOTS_FILE,
  sha256,
  storagePointers,
  stripComments,
  uupsContracts,
} from '../../../contracts/script/storage-layout-guard.mjs';

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
  return { layout: [...l.layout], enums: [...l.enums] };
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

test('enum members come from the declaring library and reordering them breaks', () => {
  const src = (body) => ({ 'src/Lib.sol': stripComments(`library Lib { /* enum Status { X } */ enum Status { ${body} } }`) });
  const ledgerOf = (body) => enumMembers('enum Lib.Status', src(body)).map((m, i) => `E|enum Lib.Status|${i}|${m}`);
  assert.deepEqual(enumMembers('enum Lib.Status', src('Active, Repaid')), ['Active', 'Repaid']);
  assert.deepEqual(appendOnlyVerdict({ layout: ledgerOf('Active, Repaid') }, { layout: ledgerOf('Active, Repaid, Settled') }).breaks, []);
  assert.deepEqual(appendOnlyVerdict({ layout: ledgerOf('Active, Repaid') }, { layout: ledgerOf('Repaid, Active') }).breaks.length, 2);
  assert.ok(ledger(probeLayout([['status', 't_enum(Status)1']])).enums.includes('enum Lib.Status'));
});

test('an enum declared twice in its scope is refused', () => {
  assert.throws(() => enumMembers('enum Lib.Status', { a: 'library Lib { enum Status { A } }', b: 'library Lib { enum Status { B } }' }), /exactly one/);
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

test('positionOf evaluates the three forms the tree uses', () => {
  assert.equal(positionOf('P', 'bytes32 constant P = keccak256("a.b");'), viemKeccak(toHex('a.b')));
  assert.equal(
    positionOf('P', 'bytes32 private constant P = keccak256(abi.encode(uint256(keccak256("example.main")) - 1)) & ~bytes32(uint256(0xff));'),
    '0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500',
  );
  const lit = '0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500';
  assert.equal(positionOf('P', `/// keccak256(abi.encode(uint256(keccak256("example.main")) - 1)) & ~bytes32(uint256(0xff))\nbytes32 constant P = ${lit};`), lit);
});

test('a literal position that disagrees with its own ERC-7201 comment is refused', () => {
  const wrong = '0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab600';
  assert.throws(
    () => positionOf('P', `/// keccak256(abi.encode(uint256(keccak256("example.main")) - 1)) & ~bytes32(uint256(0xff))\nbytes32 constant P = ${wrong};`),
    /comment derives/,
  );
});

test('a changed namespace position is a break', () => {
  const v = appendOnlyVerdict({ layout: ['P|ns|0x01'] }, { layout: ['P|ns|0x02'] });
  assert.deepEqual(v.breaks, ['P|ns|0x01']);
});

// ─── Completeness helpers ────────────────────────────────────────────────

test('uupsContracts follows inheritance and skips abstract bases', () => {
  const sources = {
    'a.sol': 'abstract contract Base is Initializable, UUPSUpgradeable { }',
    'b.sol': 'contract Child is Base, Ownable { }\ncontract Direct is\n  UUPSUpgradeable\n{ }',
    'c.sol': '// contract Commented is UUPSUpgradeable {}\ncontract Plain is Ownable { }',
  };
  assert.deepEqual(uupsContracts(sources), ['Child', 'Direct']);
});

test('storagePointers resolves both pointer forms and ignores comments', () => {
  const src = `
    // x.slot := NOT_THIS
    function a() internal pure returns (Lib.Storage storage s) { bytes32 position = POS_A; assembly { s.slot := position } }
    function b() private pure returns (GuardianStorage storage $) { assembly { $.slot := POS_B } }`;
  assert.deepEqual(storagePointers(src), [
    { struct: 'Storage', constant: 'POS_A' },
    { struct: 'GuardianStorage', constant: 'POS_B' },
  ]);
});

test('storagePointers reports a pointer it cannot resolve', () => {
  const computed = 'function a() internal pure returns (S storage s) { bytes32 p = keccak256(abi.encode(k)); assembly { s.slot := p } }';
  assert.match(storagePointers(computed)[0].error, /named position constant/);
  const foreign = 'function a() internal pure returns (S storage s) { assembly { other.slot := POS } }';
  assert.match(storagePointers(foreign)[0].error, /returned storage pointer/);
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

test('a malformed acknowledgement is an error, not a silent ack', () => {
  const ok = { baseSha256: 'a'.repeat(64), lines: ['L|ns|0|0|uint256|a'], reason: 'x' };
  assert.equal(readAcks(JSON.stringify({ acks: [ok] })).length, 1);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, baseSha256: 'abc' }] })), /baseSha256/);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, lines: [] }] })), /lines/);
  assert.throws(() => readAcks(JSON.stringify({ acks: [{ ...ok, reason: ' ' }] })), /reason/);
});

// ─── The committed files ─────────────────────────────────────────────────

test('the committed golden file names every root and the positions the sources declare', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'));
  const roots = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'));
  const expectedRoots = [...roots.namespaces.map((n) => n.id), ...roots.uups.map((c) => `uups:${c}`)].sort();
  assert.deepEqual(golden.roots, expectedRoots);
  for (const ns of roots.namespaces) {
    const raw = readFileSync(join(CONTRACTS_DIR, ns.positionFile), 'utf8');
    assert.ok(golden.layout.includes(`P|${ns.id}|${positionOf(ns.positionConstant, raw)}`), `${ns.id} position`);
  }
  assert.equal(sha256('x').length, 64);
});
