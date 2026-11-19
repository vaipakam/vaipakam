// Tests for contracts/script/check-loan-accrual-writer.mjs (#3779).
//
// Hand-built AST nodes in the shape solc emits, as in the loan-terms writer
// check's tests, which share the walk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, HOME, accrualWriteSites, verdict } from '../../../contracts/script/check-loan-accrual-writer.mjs';

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

const writes = (u) => Object.fromEntries([...accrualWriteSites([u])].map(([k, s]) => [k, s.writes]));

test('a write to a stored loan accrual start or settled interest is counted; other fields, memory copies and whole records are not', () => {
  const u = unit('src/facets/X.sol', 'X', 'f', [
    assign(member('interestAccrualStart')),
    assign(member('interestSettled'), '+='),
    assign(member('principal')),
    assign(member('interestSettled', LOAN_MEM)),
    assign({ nodeType: 'IndexAccess', typeDescriptions: { typeString: LOAN_REF } }),
  ]);
  assert.deepEqual(writes(u), { 'src/facets/X.sol:X.f': 2 });
});

test('the home library is not counted', () => {
  assert.deepEqual(writes(unit(HOME, 'LibInterestLedger', 'restartAccrual', [assign(member('interestAccrualStart'))])), {});
});

test('an unlisted site fails, the listed site with its count passes, a stale entry fails', () => {
  const bad = accrualWriteSites([unit('src/facets/X.sol', 'X', 'f', [assign(member('interestAccrualStart'))])]);
  const problems = verdict(bad);
  assert.ok(problems.some((p) => p.includes('src/facets/X.sol:X.f') && p.includes('restartAccrual')));
  assert.ok(problems.some((p) => p.includes(ALLOWED[0].site) && p.includes('no longer writes')));
  const ok = accrualWriteSites(
    ALLOWED.map((e) => {
      const [file, rest] = e.site.split(':');
      const [contract, fn] = rest.split('.');
      return unit(file, contract, fn, Array.from({ length: e.writes }, () => assign(member('interestSettled'), '+=')));
    }),
  );
  assert.deepEqual(verdict(ok), []);
});
