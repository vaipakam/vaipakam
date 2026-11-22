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

test('an encoded call to another platform contract reaches that contract, not the Diamond routing', () => {
  const E = errDef('E', '0xeeeeeeee');
  const F = errDef('F', '0xffffffff');
  // The vault answers grant(); a facet ALSO routes a grant() with the same selector.
  const vaultGrant = fn('grant', block(revertWith(E)), { selector: '0x0000aaaa' });
  const Vault = contract('Vault', [E, vaultGrant]);
  const Other = contract('OtherFacet', [F, fn('grant', block(revertWith(F)), { selector: '0x0000aaaa' }), fn('extra', block(), { selector: '0x0000bbbb' })]);
  const encodeCall = { nodeType: 'MemberAccess', memberName: 'encodeCall', expression: { nodeType: 'Identifier', name: 'abi' } };
  const caller = fn('go', block(stmt(call(encodeCall, [ref(vaultGrant)]))), { selector: '0x00000002' });
  const C = contract('CallerFacet', [caller]);
  const { raisers } = raisersFrom(
    [unit('src/V.sol', Vault), unit('src/O.sol', Other), unit('src/C.sol', C)],
    manifest(['CallerFacet', 'OtherFacet'], ['Vault']),
  );
  assert.deepEqual(raisers['0xeeeeeeee'], ['CallerFacet.go(0x00000002)', 'Vault.grant(0x0000aaaa)']);
  assert.deepEqual(raisers['0xffffffff'], ['OtherFacet.grant(0x0000aaaa)']);
});

test('a creation runs every constructor in the lineage, its initialisers and base arguments, wherever the contract is declared', () => {
  const B = errDef('B', '0xbbbbbbbb');
  const I = errDef('I', '0x11111111');
  const G = errDef('G', '0x22222222');
  const N = errDef('N', '0x33333333');
  // lib/ base whose constructor raises through an internal library helper.
  const check = fn('check', block(revertWith(B)), { visibility: 'internal' });
  const Lib = contract('Utils', [B, check], { contractKind: 'library' });
  const baseCtor = fn('', block(stmt(call(ref(check)))), { kind: 'constructor', visibility: 'public' });
  const Base = contract('BaseProxy', [baseCtor]);
  // The created contract: an initialiser and a base-constructor argument that raise.
  const init = fn('init', block(revertWith(I)), { visibility: 'internal' });
  const arg = fn('arg', block(revertWith(G)), { visibility: 'internal' });
  const stateVar = { nodeType: 'VariableDeclaration', id: id(), name: 'x', value: call(ref(init)) };
  const Proxy = contract('Proxy', [I, G, init, arg, stateVar], { baseContracts: [{ nodeType: 'InheritanceSpecifier', arguments: [call(ref(arg))] }] });
  Proxy.linearizedBaseContracts = [Proxy.id, Base.id];
  // Never created: its constructor's error must not be listed.
  const Unused = contract('Unused', [N, fn('', block(revertWith(N)), { kind: 'constructor', visibility: 'public' })]);
  const newProxy = { nodeType: 'FunctionCallOptions', expression: { nodeType: 'NewExpression', typeName: { nodeType: 'UserDefinedTypeName', referencedDeclaration: Proxy.id } } };
  const make = fn('make', block(stmt(call(newProxy))), { selector: '0x00000003' });
  const F = contract('FactoryFacet', [make]);
  const { raisers } = raisersFrom(
    [unit('lib/Utils.sol', Lib), unit('lib/Base.sol', Base), unit('lib/Proxy.sol', Proxy), unit('src/U.sol', Unused), unit('src/F.sol', F)],
    manifest(['FactoryFacet']),
  );
  assert.deepEqual(raisers['0xbbbbbbbb'], ['FactoryFacet.make(0x00000003)']);
  assert.deepEqual(raisers['0x11111111'], ['FactoryFacet.make(0x00000003)']);
  assert.deepEqual(raisers['0x22222222'], ['FactoryFacet.make(0x00000003)']);
  assert.equal(raisers['0x33333333'], undefined);
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

test('a src/ interface reaches a contract that has all its functions without inheriting it, and not one that has only some', () => {
  const E = errDef('E', '0xeeeeeeee');
  const iMint = fn('mint', null, { selector: '0x0000aaaa' });
  iMint.implemented = false;
  const iOwner = fn('owner', null, { selector: '0x0000bbbb' });
  iOwner.implemented = false;
  const I = contract('INarrow', [iMint, iOwner], { contractKind: 'interface' });
  // Answers both selectors, `owner` as a public state variable; inherits nothing.
  const full = contract('Full', [E, fn('mint', block(revertWith(E)), { selector: '0x0000aaaa' }), { nodeType: 'VariableDeclaration', name: 'owner', functionSelector: '0000bbbb' }]);
  // Answers `mint` only.
  const F = errDef('F', '0xffffffff');
  const partial = contract('Partial', [F, fn('mint', block(revertWith(F)), { selector: '0x0000aaaa' })]);
  const ext = call({ nodeType: 'MemberAccess', memberName: 'mint', expression: { nodeType: 'Identifier', name: 'n' }, referencedDeclaration: iMint.id, typeDescriptions: { typeString: 'function () external' } });
  const U = contract('User', [fn('use', block(stmt(ext)), { selector: '0x00000003' })]);
  const { raisers } = raisersFrom([unit('src/I.sol', I), unit('src/Full.sol', full), unit('src/Partial.sol', partial), unit('src/U.sol', U)], manifest(['User'], ['Full', 'Partial']));
  assert.deepEqual(raisers['0xeeeeeeee'], ['Full.mint(0x0000aaaa)', 'User.use(0x00000003)']);
  assert.deepEqual(raisers['0xffffffff'], ['Partial.mint(0x0000aaaa)']);
});

test('a src/ interface whose functions the Diamond routes, across facets, reaches each hosting facet from a standalone contract', () => {
  const E = errDef('E', '0xeeeeeeee');
  const F = errDef('F', '0xffffffff');
  const iSet = fn('set', null, { selector: '0x0000aaaa' });
  iSet.implemented = false;
  const iFund = fn('fund', null, { selector: '0x0000bbbb' });
  iFund.implemented = false;
  const I = contract('ISurface', [iSet, iFund], { contractKind: 'interface' });
  const A = contract('SetFacet', [E, fn('set', block(revertWith(E)), { selector: '0x0000aaaa' })]);
  const B = contract('FundFacet', [F, fn('fund', block(revertWith(F)), { selector: '0x0000bbbb' })]);
  const ext = call({ nodeType: 'MemberAccess', memberName: 'fund', expression: { nodeType: 'Identifier', name: 'diamond' }, referencedDeclaration: iFund.id, typeDescriptions: { typeString: 'function () external' } });
  const Adapter = contract('Adapter', [fn('deposit', block(stmt(ext)), { selector: '0x00000003' })]);
  const units = [unit('src/I.sol', I), unit('src/A.sol', A), unit('src/B.sol', B), unit('src/Ad.sol', Adapter)];
  const { raisers } = raisersFrom(units, manifest(['SetFacet', 'FundFacet'], ['Adapter']));
  assert.deepEqual(raisers['0xffffffff'], ['Adapter.deposit(0x00000003)', 'FundFacet.fund(0x0000bbbb)']);
  assert.deepEqual(raisers['0xeeeeeeee'], ['SetFacet.set(0x0000aaaa)']);
  // With one of its functions unrouted, the interface does not reach the Diamond.
  const { raisers: partial } = raisersFrom(units, manifest(['FundFacet'], ['Adapter', 'SetFacet']));
  assert.deepEqual(partial['0xffffffff'], ['FundFacet.fund(0x0000bbbb)']);
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
