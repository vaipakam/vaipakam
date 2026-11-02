// Tests for contracts/script/check-permissionless-steps.mjs (#2984).
//
// The gate rules read solc's AST. These cases build small nodes in the shape
// solc emits, so each rule is pinned on its own; the last tests run the
// committed ledger against the keeper's real sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSES,
  KEEPER_ENV,
  LEDGER_FILE,
  PASS_SCHEDULE,
  coverageProblems,
  entryPoints,
  envKeys,
  keeperProblems,
  passNames,
  readLedger,
  rowProblems,
} from '../../../contracts/script/check-permissionless-steps.mjs';

// ─── AST builders ────────────────────────────────────────────────────────

let nextId = 1;
const id = () => nextId++;

const msgSender = () => ({ nodeType: 'MemberAccess', memberName: 'sender', expression: { nodeType: 'Identifier', name: 'msg' } });
const ident = (name, referencedDeclaration) => ({ nodeType: 'Identifier', name, referencedDeclaration });
const lit = (value) => ({ nodeType: 'Literal', value });
const bin = (operator, leftExpression, rightExpression) => ({ nodeType: 'BinaryOperation', operator, leftExpression, rightExpression });
const not = (subExpression) => ({ nodeType: 'UnaryOperation', operator: '!', subExpression });
const revert = () => ({ nodeType: 'RevertStatement' });
const ifRevert = (condition) => ({ nodeType: 'IfStatement', condition, trueBody: revert() });
const ifElse = (condition, trueBody, falseBody) => ({ nodeType: 'IfStatement', condition, trueBody, falseBody });
const block = (...statements) => ({ nodeType: 'Block', statements });
const ret = () => ({ nodeType: 'Return' });
const exprStmt = (expression) => ({ nodeType: 'ExpressionStatement', expression });
const call = (expression, args = [], typeString = 'function ()') => ({
  nodeType: 'FunctionCall',
  kind: 'functionCall',
  expression: { ...expression, typeDescriptions: { typeString } },
  arguments: args,
});
const require_ = (cond) => exprStmt(call(ident('require'), [cond]));
/** `hasRole(R, msg.sender)`, a check of the sender. */
const hasRole = () => ({ nodeType: 'FunctionCall', expression: ident('hasRole'), arguments: [ident('R'), msgSender()], typeDescriptions: { typeString: 'bool' } });
const owner = () => ident('owner', 9999);
const placeholder = () => ({ nodeType: 'PlaceholderStatement' });
const param = (name = 'p') => ({ nodeType: 'VariableDeclaration', id: id(), name, typeDescriptions: { typeString: 'address' } });
const varDecl = (decl, initialValue) => ({ nodeType: 'VariableDeclarationStatement', declarations: [decl], initialValue });

function fnDef(name, statements, { visibility = 'external', mutability = 'nonpayable', modifiers = [], params = [], virtual = false, body = true } = {}) {
  return {
    nodeType: 'FunctionDefinition',
    id: id(),
    kind: 'function',
    name,
    implemented: body,
    visibility,
    virtual,
    stateMutability: mutability,
    functionSelector: visibility === 'external' || visibility === 'public' ? `sel_${name}` : undefined,
    parameters: { parameters: params },
    modifiers,
    body: body ? block(...statements) : undefined,
  };
}

function modDef(name, statements, { params = [], virtual = false } = {}) {
  return { nodeType: 'ModifierDefinition', id: id(), name, virtual, parameters: { parameters: params }, body: block(...statements) };
}

const useMod = (def, args = []) => ({ modifierName: { name: def.name, referencedDeclaration: def.id }, arguments: args });

/** One source unit holding one contract, plus any extra contracts it inherits from. */
function build(nodes, bases = []) {
  const c = { nodeType: 'ContractDefinition', id: id(), name: 'C', nodes };
  c.linearizedBaseContracts = [c.id, ...bases.map((b) => b.id)];
  return { units: [{ nodeType: 'SourceUnit', absolutePath: 'src/C.sol', nodes: [c, ...bases] }], contract: c };
}

function base(name, nodes) {
  const b = { nodeType: 'ContractDefinition', id: id(), name, nodes };
  b.linearizedBaseContracts = [b.id];
  return b;
}

/** The gate of each external function of the built contract (undefined when open). */
function gates(nodes, bases) {
  const { units } = build(nodes, bases);
  const { entries } = entryPoints(units, ['C']);
  return Object.fromEntries(entries.map((e) => [e.name, e.gate]));
}

const isGated = (nodes, bases) => Object.fromEntries(Object.entries(gates(nodes, bases)).map(([k, v]) => [k, Boolean(v)]));

// ─── Gate rules ──────────────────────────────────────────────────────────

test('if (sender != X) revert gates; if (sender == X) revert does not', () => {
  assert.deepEqual(
    isGated([fnDef('a', [ifRevert(bin('!=', msgSender(), owner()))]), fnDef('b', [ifRevert(bin('==', msgSender(), owner()))])]),
    { a: true, b: false },
  );
});

test('require of a check of the sender gates; require of anything else does not', () => {
  assert.deepEqual(
    isGated([fnDef('a', [require_(hasRole())]), fnDef('b', [require_(bin('>', ident('x'), lit('0')))]), fnDef('c', [require_(bin('==', msgSender(), owner()))])]),
    { a: true, b: false, c: true },
  );
});

test('&& gates only when every side rejects others; || gates when one side does', () => {
  const ne = () => bin('!=', msgSender(), owner());
  assert.deepEqual(
    isGated([
      fnDef('both', [ifRevert(bin('&&', ne(), bin('!=', msgSender(), ident('keeper'))))]),
      fnDef('oneAnd', [ifRevert(bin('&&', ne(), ident('flag')))]),
      fnDef('oneOr', [ifRevert(bin('||', ident('flag'), ne()))]),
      fnDef('negated', [ifRevert(not(hasRole()))]),
    ]),
    { both: true, oneAnd: false, oneOr: true, negated: true },
  );
});

test('a modifier gates before its `_`, not after it', () => {
  const before = modDef('onlyOwner', [ifRevert(bin('!=', msgSender(), owner())), placeholder()]);
  const after = modDef('logged', [placeholder(), ifRevert(bin('!=', msgSender(), owner()))]);
  assert.deepEqual(
    isGated([before, after, fnDef('a', [], { modifiers: [useMod(before)] }), fnDef('b', [], { modifiers: [useMod(after)] })]),
    { a: true, b: false },
  );
});

test('an internal call gates when its body tests a parameter bound to the sender', () => {
  const who = param('who');
  const helper = fnDef('_check', [ifRevert(bin('!=', ident('who', who.id), owner()))], { visibility: 'internal', params: [who] });
  assert.deepEqual(
    isGated([
      helper,
      fnDef('a', [exprStmt(call(ident('_check', helper.id), [msgSender()]))]),
      fnDef('b', [exprStmt(call(ident('_check', helper.id), [ident('someone')]))]),
    ]),
    { a: true, b: false },
  );
});

test('an external call never gates: its sender is this contract', () => {
  const target = fnDef('onlyFromCaller', [ifRevert(bin('!=', msgSender(), owner()))]);
  const ext = { nodeType: 'MemberAccess', memberName: 'onlyFromCaller', referencedDeclaration: target.id, expression: ident('other') };
  const { units } = build([fnDef('a', [exprStmt(call(ext, [], 'function () external'))])], [base('Other', [target])]);
  assert.equal(entryPoints(units, ['C']).entries.find((e) => e.name === 'a').gate, undefined);
});

test('a virtual call resolves to the override the analyzed contract carries', () => {
  const abstractAuth = fnDef('_authorizeUpgrade', [], { visibility: 'internal', virtual: true, body: false });
  const upgrade = fnDef('upgradeToAndCall', [exprStmt(call(ident('_authorizeUpgrade', abstractAuth.id)))], { visibility: 'public' });
  const uups = base('UUPS', [abstractAuth, upgrade]);
  const override = fnDef('_authorizeUpgrade', [ifRevert(bin('!=', msgSender(), owner()))], { visibility: 'internal', virtual: true });
  assert.equal(isGated([override], [uups]).upgradeToAndCall, true);
});

test('a return before the gate opens the function; an early return only the allowed caller takes does not', () => {
  const gate = () => ifRevert(bin('!=', msgSender(), ident('keeper')));
  assert.deepEqual(
    isGated([
      fnDef('anyReturn', [{ nodeType: 'IfStatement', condition: ident('done'), trueBody: block(ret()) }, gate()]),
      fnDef('allowedReturn', [{ nodeType: 'IfStatement', condition: bin('==', msgSender(), owner()), trueBody: block(ret()) }, gate()]),
    ]),
    { anyReturn: false, allowedReturn: true },
  );
});

test('an if/else gates only when every branch gates or reverts', () => {
  const g = () => block(ifRevert(bin('!=', msgSender(), owner())));
  assert.deepEqual(
    isGated([
      fnDef('both', [ifElse(ident('x'), g(), g())]),
      fnDef('elseReverts', [ifElse(ident('x'), g(), revert())]),
      fnDef('oneBranch', [ifElse(ident('x'), g(), block(exprStmt(call(ident('noop')))))]),
      fnDef('nested', [block(ifRevert(bin('!=', msgSender(), owner())))]),
    ]),
    { both: true, elseReverts: true, oneBranch: false, nested: true },
  );
});

test('a local holding a check of the sender gates; a number computed from the sender does not', () => {
  const ch = param('ch');
  const byOwner = param('byOwner');
  const owed = param('owed');
  const lookup = { nodeType: 'IndexAccess', baseExpression: ident('channelOf'), indexExpression: msgSender(), typeDescriptions: { typeString: 'bytes32' } };
  const eq = { ...bin('==', msgSender(), owner()), typeDescriptions: { typeString: 'bool' } };
  const amount = { nodeType: 'FunctionCall', expression: ident('_withdraw'), arguments: [msgSender()], typeDescriptions: { typeString: 'uint256' } };
  const zero = { nodeType: 'FunctionCall', kind: 'typeConversion', arguments: [lit('0')] };
  assert.deepEqual(
    isGated([
      fnDef('mapping', [varDecl(ch, lookup), ifRevert(bin('==', ident('ch', ch.id), zero))]),
      fnDef('boolLocal', [varDecl(byOwner, eq), ifRevert(bin('&&', not(ident('byOwner', byOwner.id)), not(hasRole())))]),
      fnDef('amount', [varDecl(owed, amount), ifRevert(bin('==', ident('owed', owed.id), lit('0')))]),
    ]),
    { mapping: true, boolLocal: true, amount: false },
  );
});

test('a KYC screen is not a caller gate: it admits everyone while enforcement is off', () => {
  const kyc = { nodeType: 'FunctionCall', expression: { nodeType: 'MemberAccess', memberName: 'meetsKYCRequirement', expression: ident('profile') }, arguments: [msgSender(), ident('v')] };
  assert.deepEqual(isGated([fnDef('a', [ifRevert(not(kyc))])]), { a: false });
});

test('view and pure functions, and internal ones, are not entry points; an override hides what it overrides', () => {
  const baseFn = fnDef('f', [ifRevert(bin('!=', msgSender(), owner()))]);
  const g = gates(
    [fnDef('v', [], { mutability: 'view' }), fnDef('p', [], { mutability: 'pure' }), fnDef('i', [], { visibility: 'internal' }), fnDef('f', [])],
    [base('B', [baseFn])],
  );
  assert.deepEqual(Object.keys(g), ['f']);
  assert.equal(g.f, undefined);
});

// ─── Ledger rules ────────────────────────────────────────────────────────

const entry = (key, gate, modifiers = []) => ({ key, gate, modifiers, mutability: 'nonpayable' });

test('every open entry point needs a row; a row for a gated or missing function is stale', () => {
  const problems = coverageProblems(
    [entry('C.open()', undefined), entry('C.closed()', 'caller test'), entry('C.covered()', undefined)],
    { 'C.covered()': { class: 'user', why: 'x' }, 'C.closed()': { class: 'user', why: 'x' }, 'C.gone()': { class: 'user', why: 'x' } },
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^C\.open\(\): anyone may call/);
  assert.match(problems[1], /^C\.closed\(\): the row is stale/);
  assert.match(problems[2], /^C\.gone\(\): the row names no/);
});

test('an init row needs an initializer modifier', () => {
  const steps = { 'C.initialize()': { class: 'init', why: 'deploy' }, 'C.setup()': { class: 'init', why: 'deploy' } };
  const problems = coverageProblems([entry('C.initialize()', undefined, ['initializer']), entry('C.setup()', undefined, [])], steps);
  assert.deepEqual(problems.map((p) => p.split(':')[0]), ['C.setup()']);
});

test('each class needs its fields, and issue / pr read #<number>', () => {
  const problems = rowProblems({
    'C.a()': { class: 'keeper', pass: 'p', flag: 'F' },
    'C.b()': { class: 'gap', issue: '3097', why: 'x' },
    'C.c()': { class: 'nonsense' },
    'C.d()': { class: 'user', why: 'x' },
  });
  assert.deepEqual(problems, [
    'C.a(): class "keeper" needs `evidence`',
    'C.b(): `issue` must read #<number>',
    `C.c(): class must be one of ${Object.keys(CLASSES).join(', ')}`,
  ]);
});

test('keeper rows name a real pass, flag and sending file; pending rows are refused once the keeper sends them', () => {
  const files = { '/repo/x.ts': "sender.call('label', s, 'stepA', [])" };
  const read = (p) => files[p.replace(/^.*\/x\.ts$/, '/repo/x.ts')];
  const problems = keeperProblems(
    {
      'C.stepA(uint256)': { class: 'keeper', pass: 'p', flag: 'F', evidence: 'x.ts' },
      'C.stepB()': { class: 'keeper', pass: 'q', flag: 'G', evidence: 'x.ts' },
      'C.stepA2()': { class: 'keeper-pending', pass: 'p', flag: 'F', pr: '#1' },
      'C.stepC()': { class: 'keeper-pending', pass: 'p', flag: 'F', pr: '#1' },
      'C.alt()': { class: 'alternative', of: 'C.stepA(uint256)', why: 'x' },
      'C.badAlt()': { class: 'alternative', of: 'C.alt()', why: 'x' },
    },
    { passes: new Set(['p']), flags: new Set(['F']), keeperFiles: [{ path: 'k.ts', text: "functionName: 'stepC'" }], read },
  );
  const expected = [
    /^C\.stepB\(\): pass "q" is not in/,
    /^C\.stepB\(\): flag G is not a keeper configuration key/,
    /^C\.stepB\(\): evidence x\.ts does not name stepB/,
    /^C\.stepC\(\): the keeper now names stepC/,
    /^C\.badAlt\(\): `of` must name a keeper/,
  ];
  assert.equal(problems.length, expected.length, problems.join('\n'));
  problems.forEach((p, i) => assert.match(p, expected[i]));
});

test('pass names and configuration keys are read from the keeper sources', () => {
  assert.deepEqual([...passNames("  {\n    name: 'matcher',\n  },\n    name: 'graceDefault',\n")], ['matcher', 'graceDefault']);
  assert.deepEqual([...envKeys("export const PLAIN_VAR_KEYS = [\n  'KEEPER_ENABLED',\n  'X_ENABLED',\n] as const;")], ['KEEPER_ENABLED', 'X_ENABLED']);
});

// ─── The committed ledger ────────────────────────────────────────────────

test('the committed ledger is well formed and its keeper references hold', async () => {
  const steps = readLedger(readFileSync(LEDGER_FILE, 'utf8'));
  assert.deepEqual(rowProblems(steps), []);
  const { readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const keeperSrc = dirname(PASS_SCHEDULE);
  const keeperFiles = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) keeperFiles.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  visit(keeperSrc);
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  assert.deepEqual(
    keeperProblems(steps, {
      passes: passNames(readFileSync(PASS_SCHEDULE, 'utf8')),
      flags: envKeys(readFileSync(KEEPER_ENV, 'utf8')),
      keeperFiles,
      read,
    }),
    [],
  );
});
