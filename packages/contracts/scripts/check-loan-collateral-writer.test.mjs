// Tests for contracts/script/check-loan-collateral-writer.mjs (#3710).
//
// Hand-built AST nodes in the shape solc emits, as in the loan-terms writer
// check's tests, which share the walk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, HOME, collateralWriteSites, verdict } from '../../../contracts/script/check-loan-collateral-writer.mjs';

const LOAN_PTR = 'struct LibVaipakam.Loan storage pointer';
const LOAN_MEM = 'struct LibVaipakam.Loan memory';
const LOAN_REF = 'struct LibVaipakam.Loan storage ref';

const member = (memberName, typeString = LOAN_PTR) => ({
  nodeType: 'MemberAccess',
  memberName,
  expression: { nodeType: 'Identifier', name: 'loan', typeDescriptions: { typeString } },
  typeDescriptions: { typeString: 'uint256' },
});
const assign = (leftHandSide, operator = '=') => ({ nodeType: 'Assignment', operator, leftHandSide, src: '0:1:0' });

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

const writes = (u) => Object.fromEntries([...collateralWriteSites([u])].map(([k, s]) => [k, s.writes]));

test('every assignment form to a stored loan collateral amount is a write; other fields and memory copies are not', () => {
  const u = unit('src/facets/X.sol', 'X', 'f', [
    assign(member('collateralAmount')),
    assign(member('collateralAmount'), '-='),
    assign(member('collateralAmount'), '+='),
    assign(member('principal')),
    assign(member('collateralAmount', LOAN_MEM)),
    assign({ nodeType: 'IndexAccess', typeDescriptions: { typeString: LOAN_REF } }),
  ]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 3 });
});

test('the home library is not counted', () => {
  assert.deepEqual(writes(unit(HOME, 'LibLoanCollateral', 'reduce', [assign(member('collateralAmount'), '-=')])), {});
});

test('an unlisted site fails, a listed site with its count passes, a stale entry fails', () => {
  const bad = collateralWriteSites([unit('src/facets/X.sol', 'X', 'f', [assign(member('collateralAmount'), '-=')])]);
  const problems = verdict(bad);
  assert.ok(problems.some((p) => p.includes('src/facets/X.sol:X.f') && p.includes('outside LibLoanCollateral')));
  assert.ok(problems.some((p) => p.includes(ALLOWED[0].site) && p.includes('no longer writes')));
  const [file, rest] = ALLOWED[0].site.split(':');
  const [contract, fn] = rest.split('.');
  const ok = collateralWriteSites([
    unit(file, contract, fn, Array.from({ length: ALLOWED[0].writes }, () => assign(member('collateralAmount')))),
  ]);
  assert.deepEqual(verdict(ok), []);
});
