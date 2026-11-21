// Tests for contracts/script/check-lender-side-writer.mjs (#3760).
//
// Hand-built AST nodes in the shape solc emits, as in the loan-terms writer
// check's tests, which share the walk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME, HOST, storeWriteSites, verdict } from '../../../contracts/script/check-lender-side-writer.mjs';

const STORAGE = 'struct LibVaipakam.Storage storage pointer';
const CLAIM_REF = 'struct LibVaipakam.ClaimInfo storage ref';

const store = (memberName) => ({
  nodeType: 'IndexAccess',
  baseExpression: {
    nodeType: 'MemberAccess',
    memberName,
    expression: { nodeType: 'Identifier', name: 's', typeDescriptions: { typeString: STORAGE } },
    typeDescriptions: { typeString: 'mapping(uint256 => uint256)' },
  },
  indexExpression: { nodeType: 'Identifier', name: 'loanId' },
  typeDescriptions: { typeString: memberName === 'lenderClaims' ? CLAIM_REF : 'uint256' },
});
const member = (expression, memberName) => ({ nodeType: 'MemberAccess', memberName, expression });
const assign = (leftHandSide, operator = '=') => ({ nodeType: 'Assignment', operator, leftHandSide, src: '0:1:0' });
const del = (subExpression) => ({ nodeType: 'UnaryOperation', operator: 'delete', subExpression, src: '0:1:0' });
const ident = (id) => ({ nodeType: 'Identifier', name: 'claim', referencedDeclaration: id });
const pointer = (id, memberName = 'lenderClaims') => ({
  nodeType: 'VariableDeclarationStatement',
  declarations: [{ nodeType: 'VariableDeclaration', id, storageLocation: 'storage' }],
  initialValue: store(memberName),
});
const call = (args) => ({ nodeType: 'FunctionCall', arguments: args, src: '0:1:0' });

function unit(path, statements) {
  return {
    nodeType: 'SourceUnit',
    absolutePath: path,
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: 'X',
        nodes: [{ nodeType: 'FunctionDefinition', kind: 'function', name: 'f', body: { nodeType: 'Block', statements } }],
      },
    ],
  };
}

const writes = (u) => Object.fromEntries([...storeWriteSites([u])].map(([k, s]) => [k, s.writes]));

test('additions, subtractions, member writes and deletes of either store are writes', () => {
  const u = unit('src/facets/X.sol', [
    assign(store('heldForLender'), '+='),
    assign(store('heldForLender'), '-='),
    assign(member(store('lenderClaims'), 'claimed')),
    assign(member(store('lenderClaims'), 'amount'), '-='),
    del(store('lenderClaims')),
    assign(store('borrowerClaims')),
  ]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 5 });
});

test('a write through a storage pointer into a store counts; reads do not', () => {
  const u = unit('src/facets/X.sol', [pointer(7), assign(member(ident(7), 'claimed')), member(ident(7), 'amount')]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 1 });
});

test('a storage reference passed to a call counts as a write at the call', () => {
  const u = unit('src/facets/X.sol', [pointer(9), call([ident(9)]), call([store('lenderClaims')])]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 2 });
});

test('the home library and its host are not counted, and an unlisted site fails', () => {
  assert.deepEqual(writes(unit(HOME, [assign(store('heldForLender'), '+=')])), {});
  assert.deepEqual(writes(unit(HOST, [assign(member(store('lenderClaims'), 'amount'))])), {});
  const problems = verdict(storeWriteSites([unit('src/facets/X.sol', [assign(store('heldForLender'), '+=')])]));
  assert.ok(problems.some((p) => p.includes('src/facets/X.sol:X.f') && p.includes('outside LibLenderSide')));
});
