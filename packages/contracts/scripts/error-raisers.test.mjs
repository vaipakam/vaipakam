// Tests for contracts/script/error-raisers.mjs (#3916).
//
// The rule reads solc's AST. Small nodes in the shape solc emits pin each part
// of it; the last tests check samples of the committed map by hand-checked
// call paths, including errors raised inside a self-called host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import { raisersFrom, errorDeclaration, RAISERS_FILE } from '../../../contracts/script/error-raisers.mjs';

let nextId = 1000;
const id = () => nextId++;

const errDef = (name, selector, params = []) => ({ nodeType: 'ErrorDefinition', id: id(), name, errorSelector: selector.slice(2), parameters: { parameters: params } });
const ref = (d) => ({ nodeType: 'Identifier', name: d.name, referencedDeclaration: d.id });
const call = (expression, args = [], extra = {}) => ({ nodeType: 'FunctionCall', expression, arguments: args, ...extra });
const revertWith = (d) => ({ nodeType: 'RevertStatement', errorCall: call(ref(d)) });
const stmt = (expression) => ({ nodeType: 'ExpressionStatement', expression });
const block = (...statements) => ({ nodeType: 'Block', statements });
const selectorOf = (d) => ({ nodeType: 'MemberAccess', memberName: 'selector', expression: ref(d) });
const fn = (name, body, { selector, visibility = 'external', virtual = false, modifiers = [], kind = 'function' } = {}) => ({
  nodeType: 'FunctionDefinition',
  id: id(),
  name,
  kind,
  visibility,
  virtual,
  implemented: true,
  functionSelector: selector?.slice(2),
  parameters: { parameters: [] },
  modifiers,
  body,
});
const contract = (name, nodes, extra = {}) => {
  const c = { nodeType: 'ContractDefinition', id: id(), name, nodes, contractKind: 'contract', abstract: false, ...extra };
  c.linearizedBaseContracts = extra.linearizedBaseContracts ?? [c.id];
  return c;
};
const unit = (path, ...nodes) => ({ nodeType: 'SourceUnit', absolutePath: path, nodes });
const manifest = (facets, standalone = [], proxy = []) => ({ facets, standalone, proxy });

test('revert, require with an error, and E.selector passed to a call are raises; a comparison is not', () => {
  const A = errDef('A', '0xaaaaaaaa');
  const B = errDef('B', '0xbbbbbbbb');
  const C = errDef('C', '0xcccccccc');
  const D = errDef('D', '0xdddddddd');
  const helper = fn('bubble', block(), { visibility: 'internal' });
  const f = fn(
    'f',
    block(
      revertWith(A),
      stmt(call({ nodeType: 'Identifier', name: 'require' }, [{ nodeType: 'Literal' }, call(ref(B))])),
      stmt(call(ref(helper), [selectorOf(C)])),
      stmt({ nodeType: 'BinaryOperation', operator: '==', leftExpression: { nodeType: 'Identifier', name: 'x' }, rightExpression: selectorOf(D) }),
      stmt(call({ nodeType: 'Identifier', name: 'require' }, [{ nodeType: 'Literal' }, { nodeType: 'Literal', typeDescriptions: { typeString: 'literal_string "no"' } }])),
    ),
    { selector: '0x00000001' },
  );
  const X = contract('X', [A, B, C, D, helper, f]);
  const { raisers } = raisersFrom([unit('src/X.sol', X)], manifest(['X']));
  assert.deepEqual(raisers['0xaaaaaaaa'], ['X.f(0x00000001)']);
  assert.deepEqual(raisers['0xbbbbbbbb'], ['X.f(0x00000001)']);
  assert.deepEqual(raisers['0xcccccccc'], ['X.f(0x00000001)']);
  assert.equal(raisers['0xdddddddd'], undefined);
  assert.deepEqual(raisers['0x08c379a0'], ['X.f(0x00000001)']);
});

test('a self-call by selector reaches the facet that implements it', () => {
  const E = errDef('E', '0xeeeeeeee');
  const host = fn('host', block(revertWith(E)), { selector: '0x12345678' });
  const H = contract('Host', [E, host]);
  const encode = { nodeType: 'MemberAccess', memberName: 'encodeWithSelector', expression: { nodeType: 'Identifier', name: 'abi' } };
  const caller = fn('go', block(stmt(call(encode, [{ nodeType: 'MemberAccess', memberName: 'selector', expression: ref(host) }]))), { selector: '0x00000002' });
  const C = contract('Caller', [caller]);
  const { raisers } = raisersFrom([unit('src/H.sol', H), unit('src/C.sol', C)], manifest(['Host', 'Caller']));
  assert.deepEqual(raisers['0xeeeeeeee'], ['Caller.go(0x00000002)', 'Host.host(0x12345678)']);
});

test('super.f() is not re-dispatched into the override, and call options are seen through', () => {
  const E = errDef('E', '0xeeeeeeee');
  const baseF = fn('f', block(revertWith(E)), { selector: '0x0000000f', visibility: 'public', virtual: true });
  const Base = contract('Base', [E, baseF]);
  const superCall = call({ nodeType: 'MemberAccess', memberName: 'f', expression: { nodeType: 'Identifier', name: 'super' }, referencedDeclaration: baseF.id, typeDescriptions: { typeString: 'function ()' } });
  const childF = fn('f', block(stmt(superCall)), { selector: '0x0000000f', visibility: 'public' });
  const Child = contract('Child', [childF], {});
  Child.linearizedBaseContracts = [Child.id, Base.id];
  const { raisers } = raisersFrom([unit('src/B.sol', Base), unit('src/C.sol', Child)], manifest([], ['Child']));
  assert.deepEqual(raisers['0xeeeeeeee'], ['Child.f(0x0000000f)']);
});

test('a typed call to a src/ interface reaches the shipped contract that implements it; a lib/ interface does not', () => {
  const E = errDef('E', '0xeeeeeeee');
  const iRead = fn('read', null, { selector: '0x0000aaaa' });
  iRead.implemented = false;
  const I = contract('IReader', [iRead], { contractKind: 'interface' });
  const impl = fn('read', block(revertWith(E)), { selector: '0x0000aaaa' });
  const R = contract('Reader', [E, impl]);
  R.linearizedBaseContracts = [R.id, I.id];
  const ext = (target) =>
    call(
      { nodeType: 'FunctionCallOptions', expression: { nodeType: 'MemberAccess', memberName: 'read', expression: { nodeType: 'Identifier', name: 'r' }, referencedDeclaration: target.id, typeDescriptions: { typeString: 'function () view external' } } },
      [],
    );
  const user = fn('use', block(stmt(ext(iRead))), { selector: '0x00000003' });
  const U = contract('User', [user]);
  const { raisers } = raisersFrom([unit('src/I.sol', I), unit('src/R.sol', R), unit('src/U.sol', U)], manifest(['User'], ['Reader']));
  assert.deepEqual(raisers['0xeeeeeeee'], ['Reader.read(0x0000aaaa)', 'User.use(0x00000003)']);
  const { raisers: viaLib } = raisersFrom([unit('lib/I.sol', I), unit('src/R.sol', R), unit('src/U.sol', U)], manifest(['User'], ['Reader']));
  assert.deepEqual(viaLib['0xeeeeeeee'], ['Reader.read(0x0000aaaa)']);
});

test('an error declaration expands enums, contracts and structs to ABI types', () => {
  const en = { nodeType: 'EnumDefinition', id: id(), name: 'K' };
  const st = { nodeType: 'StructDefinition', id: id(), name: 'S', members: [{ name: 'a', typeName: { nodeType: 'ElementaryTypeName', name: 'uint256' } }] };
  const byId = new Map([[en.id, en], [st.id, st]]);
  const d = errDef('E', '0x00000000', [
    { name: 'k', typeName: { nodeType: 'UserDefinedTypeName', referencedDeclaration: en.id } },
    { name: 's', typeName: { nodeType: 'ArrayTypeName', baseType: { nodeType: 'UserDefinedTypeName', referencedDeclaration: st.id } } },
  ]);
  assert.equal(errorDeclaration(d, byId).signature, 'E(uint8,(uint256)[])');
});

// ─── Hand-checked samples of the committed map ───────────────────────────

const committed = JSON.parse(readFileSync(RAISERS_FILE, 'utf8')).raisers;
const raisedBy = (sig) => committed[toFunctionSelector(sig).toLowerCase()] ?? [];

test('an error raised inside a self-called host is listed under the entry that self-calls it', () => {
  // RiskFacet.triggerLiquidation and DefaultedFacet.triggerDefault self-call
  // FallbackCustodyFacet.enterFallback when every swap route fails (#1566 S2a),
  // which raises FallbackSnapshotMismatch.
  const list = raisedBy('FallbackSnapshotMismatch(uint256,uint256,uint256)');
  assert.ok(list.some((k) => k.startsWith('RiskFacet.triggerLiquidation(')), list.join(' '));
  assert.ok(list.some((k) => k.startsWith('DefaultedFacet.triggerDefault(')), list.join(' '));
});

test('a price refusal raised by the price guard reader is listed under the Diamond entries that price', () => {
  // OracleFacet reads through PriceGuard, which delegates to PriceGuardReader.
  const list = raisedBy('SequencerDown()');
  assert.ok(list.some((k) => k.startsWith('PriceGuard.getAssetPrice(')), list.join(' '));
  assert.ok(list.some((k) => k.startsWith('OfferAcceptFacet.acceptOffer(')), list.join(' '));
});

test('the Diamond proxy fallback is an entry of its own', () => {
  assert.ok(raisedBy('FunctionDoesNotExist()').includes('VaipakamDiamond.fallback'));
});
