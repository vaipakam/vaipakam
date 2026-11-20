// Tests for contracts/script/check-wallet-payouts.mjs (payout rule, owner
// decision 2026-11-19).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, doorSites, verdict } from '../../../contracts/script/check-wallet-payouts.mjs';

const lib = (name, member) => ({
  nodeType: 'MemberAccess',
  memberName: member,
  expression: { nodeType: 'Identifier', name, typeDescriptions: { typeString: `type(library ${name})` } },
  src: '0:1:0',
});
const cls = (member) => ({
  nodeType: 'MemberAccess',
  memberName: member,
  expression: { nodeType: 'Identifier', typeDescriptions: { typeString: 'type(enum VaultOutflowTypes.OutflowClass)' } },
  src: '0:1:0',
});

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
const counts = (u) => Object.fromEntries([...doorSites([u])].map(([k, s]) => [k, s.count]));

test('wallet doors, pushes and the wallet classes are counted; other outflows are not', () => {
  const u = unit('src/facets/X.sol', 'X', 'f', [
    lib('LibVaultOutflow', 'toOwner'),
    lib('LibVaultOutflow', 'toAllowlisted'),
    lib('LibDelivery', 'pushOut'),
    lib('LibDelivery', 'pushExact'),
    lib('LibDelivery', 'pushMeasured'),
    cls('Owner'),
    cls('OwnerAllowlisted'),
    lib('LibVaultOutflow', 'releaseOwn'),
    lib('LibVaultOutflow', 'toPositionHolder'),
    cls('PositionHolder'),
    lib('LibDelivery', 'pullExact'),
  ]);
  assert.deepEqual(counts(u), { 'src/facets/X.sol:X.f': 7 });
});

test('the doors themselves are not counted', () => {
  for (const p of ['src/facets/VaultOutflowFacet.sol', 'src/libraries/LibVaultOutflow.sol', 'src/libraries/LibDelivery.sol']) {
    assert.deepEqual(counts(unit(p, 'H', 'f', [lib('LibVaultOutflow', 'toOwner')])), {});
  }
});

test('a new wallet payout fails; a listed site at its count passes', () => {
  const sites = doorSites([unit('src/facets/New.sol', 'New', 'pay', [lib('LibVaultOutflow', 'toOwner')])]);
  assert.ok(verdict(sites).some((p) => p.startsWith('src/facets/New.sol:New.pay') && p.includes('into its vault')));
  const e = ALLOWED[0];
  const [file, rest] = e.site.split(':');
  const [c, fn] = rest.split('.');
  const ok = doorSites([unit(file, c, fn, Array.from({ length: e.count }, () => lib('LibVaultOutflow', 'toOwner')))]);
  assert.deepEqual(verdict(ok, [e]), []);
});
