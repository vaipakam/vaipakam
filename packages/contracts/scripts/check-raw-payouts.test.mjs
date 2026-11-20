// Tests for contracts/script/check-raw-payouts.mjs (#3710 §3.8).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, transferSites, verdict } from '../../../contracts/script/check-raw-payouts.mjs';

const member = (memberName) => ({ nodeType: 'MemberAccess', memberName, expression: { nodeType: 'Identifier', name: 't' } });
const call = (expression, args = []) => ({ nodeType: 'FunctionCall', expression, arguments: args, src: '0:1:0' });
const withValue = (expression) => ({ nodeType: 'FunctionCallOptions', names: ['value'], expression });

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
const counts = (u) => Object.fromEntries([...transferSites([u])].map(([k, s]) => [k, s.count]));

test('token moves, native payments and encoded transfers are counted', () => {
  const u = unit('src/facets/X.sol', 'X', 'f', [
    call(member('safeTransfer')),
    call(member('transferFrom')),
    call(member('safeTransferFrom')),
    call(withValue(member('call'))),
    { nodeType: 'MemberAccess', memberName: 'selector', expression: member('transfer') },
    call({ nodeType: 'MemberAccess', memberName: 'encodeCall', expression: { nodeType: 'Identifier', name: 'abi' } }, [member('transfer')]),
    call(member('approve')),
  ]);
  assert.deepEqual(counts(u), { 'src/facets/X.sol:X.f': 6 });
});

test('the policy, its library and LibDelivery are not counted, nor code outside facets and libraries', () => {
  for (const p of ['src/facets/VaultOutflowFacet.sol', 'src/libraries/LibVaultOutflow.sol', 'src/libraries/LibDelivery.sol', 'src/VaipakamVaultImplementation.sol']) {
    assert.deepEqual(counts(unit(p, 'H', 'f', [call(member('safeTransfer'))])), {});
  }
});

test('an unlisted transfer fails; a listed site at its count passes', () => {
  const sites = transferSites([unit('src/facets/New.sol', 'New', 'pay', [call(member('safeTransfer'))])]);
  assert.ok(verdict(sites).some((p) => p.startsWith('src/facets/New.sol:New.pay') && p.includes('outside the outflow policy')));
  const e = ALLOWED[0];
  const [file, rest] = e.site.split(':');
  const [c, fn] = rest.split('.');
  const ok = transferSites([unit(file, c, fn, Array.from({ length: e.count }, () => call(member('safeTransfer'))))]);
  assert.deepEqual(verdict(ok, [e]), []);
});

test('a call of LibDelivery.pushMeasured outside LibDelivery is counted (it skips the protected-wallet step)', () => {
  const lib = (name) => ({ nodeType: 'MemberAccess', memberName: name, expression: { nodeType: 'Identifier', name: 'LibDelivery' } });
  const u = unit('src/facets/Y.sol', 'Y', 'pay', [
    call(lib('pushMeasured')),
    call(lib('pushExact')),
    call(lib('pushOut')),
    call({ nodeType: 'MemberAccess', memberName: 'pushMeasured', expression: { nodeType: 'Identifier', name: 'Other' } }),
  ]);
  assert.deepEqual(counts(u), { 'src/facets/Y.sol:Y.pay': 1 });
  assert.ok(verdict(transferSites([u])).some((p) => p.includes('pushExact / pushOut')));
  // Inside LibDelivery itself it is the home's own move.
  assert.deepEqual(counts(unit('src/libraries/LibDelivery.sol', 'LibDelivery', 'pushExact', [call(lib('pushMeasured'))])), {});
});
