// Tests for contracts/script/check-loan-terms-writer.mjs (#1808).
//
// The check reads solc's AST. These cases use small hand-built nodes in the
// shape solc emits for each kind of write, so each rule is pinned on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, HOME, termWriteSites, verdict } from '../../../contracts/script/check-loan-terms-writer.mjs';

const LOAN_PTR = 'struct LibVaipakam.Loan storage pointer';
const LOAN_REF = 'struct LibVaipakam.Loan storage ref';
const LOAN_MEM = 'struct LibVaipakam.Loan memory';

const ident = (typeString) => ({ nodeType: 'Identifier', name: 'loan', typeDescriptions: { typeString } });
const member = (memberName, typeString = LOAN_PTR) => ({
  nodeType: 'MemberAccess',
  memberName,
  expression: ident(typeString),
  typeDescriptions: { typeString: 'uint256' },
});
const assign = (leftHandSide, operator = '=') => ({ nodeType: 'Assignment', operator, leftHandSide, src: '0:1:0' });
const unary = (operator, subExpression) => ({ nodeType: 'UnaryOperation', operator, subExpression, src: '0:1:0' });

function unit(path, contract, fn, statements) {
  return {
    nodeType: 'SourceUnit',
    absolutePath: path,
    nodes: [
      {
        nodeType: 'ContractDefinition',
        name: contract,
        nodes: [{ nodeType: 'FunctionDefinition', kind: 'function', name: fn, body: { nodeType: 'Block', statements } }],
      },
    ],
  };
}

const writes = (u) => Object.fromEntries([...termWriteSites([u])].map(([k, s]) => [k, s.writes]));

test('assignments, compound assignments, increments and deletes of either term are writes', () => {
  const u = unit('src/facets/X.sol', 'X', 'f', [
    assign(member('principal')),
    assign(member('principal'), '-='),
    assign(member('interestRateBps')),
    unary('++', member('interestRateBps')),
    unary('delete', member('principal')),
  ]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 5 });
});

test('a whole stored loan assigned or deleted is a write; a mapping entry counts, a memory copy does not', () => {
  const entry = { nodeType: 'IndexAccess', typeDescriptions: { typeString: LOAN_REF } };
  const u = unit('src/facets/X.sol', 'X', 'g', [
    assign(entry),
    unary('delete', entry),
    assign(member('principal', LOAN_MEM)),
    assign({ nodeType: 'IndexAccess', typeDescriptions: { typeString: LOAN_MEM } }),
  ]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.g': 2 });
});

test('other fields, other structs, the home library and lib/ are not counted', () => {
  const offer = {
    nodeType: 'MemberAccess',
    memberName: 'interestRateBps',
    expression: ident('struct LibVaipakam.Offer storage pointer'),
  };
  assert.deepEqual(writes(unit('src/facets/X.sol', 'X', 'h', [assign(member('collateralAmount')), assign(offer)])), {});
  assert.deepEqual(writes(unit(HOME, 'LibInterestLedger', 'reducePrincipal', [assign(member('principal'))])), {});
  assert.deepEqual(writes(unit('lib/x/Y.sol', 'Y', 'f', [assign(member('principal'))])), {});
});

test('the verdict refuses an unlisted site, a changed count and a stale entry', () => {
  const site = (n) => new Map([['src/facets/X.sol:X.f', { writes: n, refs: [] }]]);
  const allowed = [{ site: 'src/facets/X.sol:X.f', writes: 2, reason: 'test' }];
  assert.deepEqual(verdict(site(2), allowed), []);
  assert.match(verdict(site(3), allowed)[0], /listed with 2 write\(s\), found 3/);
  assert.match(verdict(site(1), [])[0], /outside LibInterestLedger/);
  assert.match(verdict(new Map(), allowed)[0], /listed, but writes neither field/);
});

test('every listed site carries a reason', () => {
  for (const e of ALLOWED) assert.ok(e.reason.length >= 20, e.site);
});
